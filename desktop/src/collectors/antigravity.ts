import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildGoogleUsageStreams,
  parseManualUsageImport,
  parseQuotaBuckets,
  type GoogleQuotaPools,
  type SanitizedAntigravitySnapshot,
} from "../../../lib/claude-usage/google-ai-pro";
import type { UsageStream } from "../types";

/**
 * Antigravity status-line adapter and desktop collector.
 *
 * Scope: Google AI Pro Antigravity coding allowance only.
 * Acquires local telemetry passively via Antigravity CLI's documented `statusLine` hook.
 *
 * Hook contract:
 * - ~/.gemini/antigravity-cli/settings.json contains:
 *   "statusLine": {
 *     "type": "command",
 *     "command": "<commandPath>",
 *     "stack_with_default": true
 *   }
 * - Antigravity CLI sends state JSON to stdin.
 * - The adapter sanitizes the JSON (recording only product, version, email, plan_tier,
 *   quota, and observed_at) and writes atomically to `antigravity-quota.json`.
 * - Stdout is reserved for status-line output; diagnostics go to stderr.
 */

export interface AntigravityStatus {
  installed: boolean;
  connected: boolean;
  statusLineConfigured: boolean;
  isOurCommand: boolean;
  existingCommand?: string | null;
  quotaFileExists: boolean;
  lastObservedAt?: string | null;
}

export interface ConnectResult {
  ok: boolean;
  conflict?: boolean;
  existingCommand?: string;
  message?: string;
}

export interface DisconnectResult {
  ok: boolean;
  message?: string;
}

export function defaultAntigravitySettingsPath(home = homedir()): string {
  return join(home, ".gemini", "antigravity-cli", "settings.json");
}

export function defaultAntigravityQuotaPath(userDataDir: string): string {
  return join(userDataDir, "antigravity-quota.json");
}

export function defaultAdapterScriptPath(userDataDir: string): string {
  return join(userDataDir, "antigravity-statusline.mjs");
}

export function defaultAdapterCmdPath(userDataDir: string): string {
  return join(userDataDir, "antigravity-statusline.cmd");
}

export function defaultAdapterShPath(userDataDir: string): string {
  return join(userDataDir, "antigravity-statusline.sh");
}

/**
 * Builds the standalone adapter script content.
 * The script runs in pure Node.js without loading Electron.
 */
export function buildAdapterScriptSource(quotaFilePath: string): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from "node:fs";

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

if (!input || !input.trim()) {
  process.exit(0);
}

try {
  const parsed = JSON.parse(input);
  if (parsed && typeof parsed === "object" && parsed.quota && typeof parsed.quota === "object") {
    const sanitized = {
      product: String(parsed.product || "antigravity"),
      version: parsed.version ? String(parsed.version) : null,
      email: parsed.email ? String(parsed.email) : null,
      plan_tier: parsed.plan_tier ? String(parsed.plan_tier) : null,
      observed_at: new Date().toISOString(),
      quota: {}
    };
    for (const [key, b] of Object.entries(parsed.quota)) {
      if (b && typeof b === "object") {
        sanitized.quota[key] = {
          remaining_fraction: typeof b.remaining_fraction === "number" ? b.remaining_fraction : null,
          reset_time: b.reset_time ? String(b.reset_time) : null,
          reset_in_seconds: typeof b.reset_in_seconds === "number" ? b.reset_in_seconds : null
        };
      }
    }
    const targetFile = process.env.DUITSINI_ANTIGRAVITY_QUOTA_FILE || ${JSON.stringify(quotaFilePath)};
    const tmpFile = targetFile + ".tmp";
    writeFileSync(tmpFile, JSON.stringify(sanitized), "utf8");
    renameSync(tmpFile, targetFile);
  }
} catch (err) {
  process.stderr.write("[duitsini-statusline] " + (err && err.message ? err.message : err) + "\\n");
}
`;
}

/**
 * Installs the adapter script files into userDataDir.
 */
export function installAdapter(userDataDir: string): { scriptPath: string; commandPath: string } {
  mkdirSync(userDataDir, { recursive: true });
  const quotaFilePath = defaultAntigravityQuotaPath(userDataDir);
  const scriptPath = defaultAdapterScriptPath(userDataDir);
  const scriptContent = buildAdapterScriptSource(quotaFilePath);
  writeFileSync(scriptPath, scriptContent, "utf8");

  if (process.platform === "win32") {
    const cmdPath = defaultAdapterCmdPath(userDataDir);
    const cmdContent = `@echo off\r\nnode "%~dp0antigravity-statusline.mjs" %*\r\n`;
    writeFileSync(cmdPath, cmdContent, "utf8");
    return { scriptPath, commandPath: cmdPath };
  } else {
    const shPath = defaultAdapterShPath(userDataDir);
    const shContent = `#!/usr/bin/env sh\nexec node "$(dirname "$0")/antigravity-statusline.mjs" "$@"\n`;
    writeFileSync(shPath, shContent, { encoding: "utf8", mode: 0o755 });
    try {
      chmodSync(shPath, 0o755);
    } catch {
      /* ignore if chmod is unsupported */
    }
    return { scriptPath, commandPath: shPath };
  }
}

/**
 * Checks whether Antigravity is installed and whether the status line is connected.
 */
export async function getAntigravityStatus(
  userDataDir: string,
  settingsPath = defaultAntigravitySettingsPath(),
): Promise<AntigravityStatus> {
  const quotaPath = defaultAntigravityQuotaPath(userDataDir);
  const quotaFileExists = existsSync(quotaPath);
  let lastObservedAt: string | null = null;

  if (quotaFileExists) {
    try {
      const content = JSON.parse(await readFile(quotaPath, "utf8")) as SanitizedAntigravitySnapshot;
      if (content?.observed_at) lastObservedAt = content.observed_at;
    } catch {
      /* ignore read/parse error */
    }
  }

  const installed = existsSync(dirname(settingsPath)) || existsSync(settingsPath);
  if (!existsSync(settingsPath)) {
    return {
      installed,
      connected: false,
      statusLineConfigured: false,
      isOurCommand: false,
      existingCommand: null,
      quotaFileExists,
      lastObservedAt,
    };
  }

  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const statusLine = raw.statusLine as { command?: string; type?: string } | undefined;
    if (!statusLine || typeof statusLine !== "object" || !statusLine.command) {
      return {
        installed: true,
        connected: false,
        statusLineConfigured: false,
        isOurCommand: false,
        existingCommand: null,
        quotaFileExists,
        lastObservedAt,
      };
    }

    const cmd = String(statusLine.command).trim();
    const cmdPath = process.platform === "win32"
      ? defaultAdapterCmdPath(userDataDir).toLowerCase()
      : defaultAdapterShPath(userDataDir);
    const scriptPath = defaultAdapterScriptPath(userDataDir).toLowerCase();
    const lowerCmd = cmd.toLowerCase();

    const isOur = lowerCmd.includes(cmdPath) || lowerCmd.includes(scriptPath) || lowerCmd.includes("antigravity-statusline");

    return {
      installed: true,
      connected: isOur,
      statusLineConfigured: true,
      isOurCommand: isOur,
      existingCommand: isOur ? null : cmd,
      quotaFileExists,
      lastObservedAt,
    };
  } catch {
    return {
      installed,
      connected: false,
      statusLineConfigured: false,
      isOurCommand: false,
      existingCommand: null,
      quotaFileExists,
      lastObservedAt,
    };
  }
}

/**
 * Connects Antigravity by configuring the custom statusLine in settings.json.
 * If another custom status-line command is already configured, reports conflict rather
 * than clobbering it.
 */
export async function connectAntigravity(
  userDataDir: string,
  settingsPath = defaultAntigravitySettingsPath(),
): Promise<ConnectResult> {
  const { commandPath } = installAdapter(userDataDir);

  await mkdir(dirname(settingsPath), { recursive: true });
  let settings: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }

  const existingStatusLine = settings.statusLine as { command?: string } | undefined;
  if (existingStatusLine?.command) {
    const existingCmd = String(existingStatusLine.command).trim();
    const lowerExisting = existingCmd.toLowerCase();
    const isOur =
      lowerExisting.includes("antigravity-statusline") ||
      lowerExisting.includes(commandPath.toLowerCase());

    if (!isOur) {
      return {
        ok: false,
        conflict: true,
        existingCommand: existingCmd,
        message: `A custom statusLine command is already configured (${existingCmd}). Please remove or combine it before connecting.`,
      };
    }
  }

  settings.statusLine = {
    type: "command",
    command: commandPath,
    stack_with_default: true,
  };

  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

  return { ok: true };
}

/**
 * Reversibly disconnects Antigravity by removing our custom statusLine from settings.json.
 */
export async function disconnectAntigravity(
  userDataDir: string,
  settingsPath = defaultAntigravitySettingsPath(),
): Promise<DisconnectResult> {
  if (!existsSync(settingsPath)) {
    return { ok: true };
  }

  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const statusLine = settings.statusLine as { command?: string } | undefined;

    if (statusLine?.command) {
      const cmd = String(statusLine.command).toLowerCase();
      if (cmd.includes("antigravity-statusline") || cmd.includes(defaultAdapterScriptPath(userDataDir).toLowerCase())) {
        delete settings.statusLine;
        await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/**
 * Active collection: run the official Antigravity CLI's `/usage` command.
 *
 * `/usage` is answered by the CLI itself (verified 2026-10-13: num_turns 0,
 * total_tokens 0), so polling it spends no quota. We never read Antigravity's
 * OAuth material or call Google's backend ourselves — that is what got AI Pro
 * accounts banned in Feb 2026 — the official binary does all network work.
 */
export const AGY_POLL_MS = 300_000;
export const AGY_USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"] as const;
const AGY_TIMEOUT_MS = 45_000;

export class AgyNotInstalledError extends Error {
  constructor() {
    super("Antigravity CLI (agy) was not found on this computer.");
  }
}

export class AgyAuthError extends Error {
  constructor() {
    super("Antigravity CLI is not signed in. Run agy once in a terminal to sign in.");
  }
}

/** `/usage` started a model turn. Polling must never spend quota, so stop. */
export class AgyModelTurnError extends Error {
  constructor() {
    super("Antigravity CLI answered /usage with a model turn; automatic polling is paused to protect your quota.");
  }
}

export function agyBinaryCandidates(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const list: string[] = [];
  if (env.DUITSINI_AGY_PATH) list.push(env.DUITSINI_AGY_PATH);
  if (platform === "win32") {
    list.push(join(home, "Tools", "agy", "bin", "agy.exe"));
    list.push(join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "agy", "bin", "agy.exe"));
  } else {
    list.push(join(home, ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy");
  }
  return list;
}

/** First existing known install location, else the bare name for a PATH lookup. */
export function resolveAgyBinary(candidates = agyBinaryCandidates()): string {
  return candidates.find((p) => existsSync(p)) ?? (process.platform === "win32" ? "agy.exe" : "agy");
}

export type AgyRunner = (
  binary: string,
  args: string[],
  options: { timeoutMs: number; cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

type RunnerError = Error & { code?: string | number; killed?: boolean; stdout?: string; stderr?: string };

const defaultAgyRunner: AgyRunner = (binary, args, { timeoutMs, cwd }) =>
  new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, cwd, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as RunnerError;
          err.stdout = String(stdout ?? "");
          err.stderr = String(stderr ?? "");
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** Parse `agy -p /usage --output-format json`, refusing anything that spent tokens. */
export function parseAgyUsageOutput(stdout: string, nowMs: number = Date.now()): GoogleQuotaPools {
  const text = stdout.trim();
  let envelope: {
    status?: unknown;
    num_turns?: unknown;
    usage?: { total_tokens?: unknown };
    command?: { name?: unknown };
  };
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("Antigravity CLI returned unreadable usage output.");
  }
  const turns = typeof envelope.num_turns === "number" ? envelope.num_turns : 0;
  const tokens = typeof envelope.usage?.total_tokens === "number" ? envelope.usage.total_tokens : 0;
  if (turns > 0 || tokens > 0 || envelope.command?.name !== "usage") throw new AgyModelTurnError();
  if (envelope.status !== "SUCCESS") {
    throw new Error(`Antigravity CLI usage check did not succeed (${String(envelope.status ?? "unknown")}).`);
  }
  const pools = parseManualUsageImport(text, nowMs);
  const hasWindow =
    pools &&
    (pools.gemini.five_hour || pools.gemini.weekly || pools.claudePartner.five_hour || pools.claudePartner.weekly);
  if (!pools || !hasWindow) throw new Error("Antigravity CLI returned no recognizable usage windows.");
  return pools;
}

export async function fetchAntigravityUsage(
  options: { binary?: string; runner?: AgyRunner; cwd?: string; nowMs?: number } = {},
): Promise<GoogleQuotaPools> {
  const binary = options.binary ?? resolveAgyBinary();
  const runner = options.runner ?? defaultAgyRunner;
  let stdout: string;
  try {
    ({ stdout } = await runner(binary, [...AGY_USAGE_ARGS], {
      timeoutMs: AGY_TIMEOUT_MS,
      cwd: options.cwd ?? homedir(),
    }));
  } catch (error) {
    const err = error as RunnerError;
    if (err.code === "ENOENT") throw new AgyNotInstalledError();
    if (/auth/i.test(err.stderr ?? "")) throw new AgyAuthError();
    throw new Error(`Antigravity CLI usage check failed${err.killed ? " (timed out)" : ""}.`);
  }
  return parseAgyUsageOutput(stdout, options.nowMs ?? Date.now());
}

/**
 * Collects Google AI Pro usage streams from the sanitized local snapshot file.
 */
export async function collectAntigravityStreams(
  quotaFilePath: string,
  nowMs: number = Date.now(),
): Promise<UsageStream[]> {
  try {
    if (!existsSync(quotaFilePath)) return [];
    const raw = await readFile(quotaFilePath, "utf8");
    if (!raw.trim()) return [];
    const snapshot = JSON.parse(raw);
    const pools = parseQuotaBuckets(snapshot);
    if (!pools) return [];

    const observedMs = new Date(pools.observedAt).getTime();
    const ageMs = Math.max(0, nowMs - observedMs);
    // Antigravity statusLine fires while the TUI is active.
    // Within 15 minutes is live; beyond that is saved/cached.
    const isLive = !Number.isNaN(observedMs) && ageMs <= 15 * 60 * 1000;
    const state = isLive ? "live" : "cached";
    const statusMessage = isLive ? null : "Saved reading from Antigravity session";

    return buildGoogleUsageStreams(pools, {
      state,
      statusMessage,
    });
  } catch {
    return [];
  }
}
