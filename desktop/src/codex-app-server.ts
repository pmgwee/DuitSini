import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, win32 as win32Path } from "node:path";
import type { CodexIdentity } from "../../lib/claude-usage/codex";

/** Read-only account identity obtained from a local Codex app-server. */
export type CodexAccountReader = (codexHome: string) => Promise<CodexIdentity | null>;

type JsonRecord = Record<string, unknown>;

const APP_SERVER_TIMEOUT_MS = 8_000;
const CACHE_MS = 5 * 60_000;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function accountIdentity(value: unknown): CodexIdentity | null {
  const root = asRecord(value);
  const account = asRecord(root?.account) ?? root;
  if (!account) return null;

  const email = text(account.email) ?? text(account.user_email) ?? text(account.userEmail);
  const memberId =
    text(account.member_id) ??
    text(account.memberId) ??
    text(account.user_id) ??
    text(account.userId) ??
    text(account.id);
  const workspaceId =
    text(account.workspace_id) ??
    text(account.workspaceId) ??
    text(account.organization_id) ??
    text(account.organizationId);
  const workspaceName =
    text(account.workspace_name) ??
    text(account.workspaceName) ??
    text(account.organization_name) ??
    text(account.organizationName);
  const planType = text(account.plan_type) ?? text(account.planType) ?? text(account.plan);

  if (!email && !memberId && !workspaceId && !workspaceName && !planType) return null;
  return {
    memberId,
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null,
    workspaceId,
    workspaceName,
    planType,
  };
}

export function codexCliInvocation(
  cliArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const pathJoin = platform === "win32" ? win32Path.join : join;
    const npmRoot = env.APPDATA?.trim() ? pathJoin(env.APPDATA, "npm") : null;
    const candidates = [
      env.DUITSINI_CODEX_EXECUTABLE?.trim(),
      npmRoot
        ? pathJoin(
            npmRoot,
            "node_modules",
            "@openai",
            "codex",
            "node_modules",
            "@openai",
            "codex-win32-x64",
            "vendor",
            "x86_64-pc-windows-msvc",
            "bin",
            "codex.exe",
          )
        : null,
      npmRoot ? pathJoin(npmRoot, "codex.cmd") : null,
      env.LOCALAPPDATA?.trim() ? pathJoin(env.LOCALAPPDATA, "npm", "codex.cmd") : null,
      "codex.cmd",
    ].filter((candidate): candidate is string => Boolean(candidate));
    const executable = candidates.find((candidate) => candidate.includes("\\") || candidate.includes("/") ? exists(candidate) : true) ?? "codex.cmd";
    if (executable.toLowerCase().endsWith(".exe")) {
      return { command: executable, args: [...cliArgs] };
    }
    // npm's .cmd shim needs ComSpec in packaged Electron. Arguments here are
    // fixed DuitSini commands; no renderer value reaches this command line.
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${executable.replace(/"/g, '""')}" ${cliArgs.join(" ")}`],
    };
  }
  return {
    command: env.DUITSINI_CODEX_EXECUTABLE?.trim() || "codex",
    args: [...cliArgs],
  };
}

export function codexAppServerInvocation(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = existsSync,
): { command: string; args: string[] } {
  return codexCliInvocation(["app-server", "--listen", "stdio://"], platform, env, exists);
}

/**
 * Ask a private, short-lived app-server for account/read(refreshToken:false).
 * The process reads Codex's own login state and never receives a switch or
 * refresh command. It is intentionally a reader seam so tests and future
 * packaged integrations can supply a verified app-server transport without
 * coupling the runtime manager to a child process.
 */
export async function readCodexAppServerAccount(
  codexHome: string,
  timeoutMs = APP_SERVER_TIMEOUT_MS,
): Promise<CodexIdentity | null> {
  if (!codexHome.trim()) return null;

  const { command, args } = codexAppServerInvocation();
  const child = spawn(command, args, {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell: false,
  });

  return new Promise((resolve) => {
    let buffer = "";
    let finished = false;
    const initializeId = `duitsini-init-${randomUUID()}`;
    const accountId = `duitsini-account-${randomUUID()}`;

    const finish = (value: CodexIdentity | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      if (!child.killed) child.kill();
      resolve(value);
    };

    const send = (message: JsonRecord) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handle = (message: JsonRecord) => {
      if (String(message.id ?? "") === initializeId) {
        // app-server uses the normal JSON-RPC initialize/initialized handshake.
        send({ method: "initialized", params: {} });
        send({ id: accountId, method: "account/read", params: { refreshToken: false } });
        return;
      }
      if (String(message.id ?? "") !== accountId) return;
      if (message.error) {
        finish(null);
        return;
      }
      finish(accountIdentity(message.result));
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const message = asRecord(JSON.parse(line));
          if (message) handle(message);
        } catch {
          // Startup diagnostics or a future framing change are ignored; the
          // timeout still leaves the caller with an honest unknown identity.
        }
      }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on("data", onData);
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));

    send({
      id: initializeId,
      method: "initialize",
      params: {
        clientInfo: { name: "duitsini", title: "DuitSini", version: "1" },
      },
    });
  });
}

/**
 * Cache the read-only probe so the renderer's 7.5s status poll does not spawn
 * a fresh app-server for every tick. Cache entries are isolated per CODEX_HOME.
 */
export function createCodexAppServerAccountReader(): CodexAccountReader {
  const cache = new Map<string, { at: number; value: CodexIdentity | null; inflight?: Promise<CodexIdentity | null> }>();
  return async (codexHome: string) => {
    const now = Date.now();
    const existing = cache.get(codexHome);
    if (existing?.inflight) return existing.inflight;
    if (existing && now - existing.at < CACHE_MS) return existing.value;

    const inflight = readCodexAppServerAccount(codexHome).then((value) => {
      cache.set(codexHome, { at: Date.now(), value });
      return value;
    });
    cache.set(codexHome, { at: now, value: existing?.value ?? null, inflight });
    try {
      return await inflight;
    } finally {
      const current = cache.get(codexHome);
      if (current?.inflight === inflight) cache.set(codexHome, { at: Date.now(), value: current.value });
    }
  };
}
