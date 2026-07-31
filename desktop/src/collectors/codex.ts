import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CODEX_USAGE_URL,
  parseCodexAuth,
  parseCodexUsage,
  type CodexUsageSnapshot,
} from "../../../lib/claude-usage/codex";
import { retryMsFrom, safeFetch } from "../net";
import { codedError, type Snapshot } from "../types";

export interface CodexCredentialSource {
  label: string;
  read: () => Promise<unknown>;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchCodexOptions {
  sources?: CodexCredentialSource[];
  fetcher?: Fetcher;
  nowMs?: number;
}

export interface CodexResult {
  snapshot: Snapshot;
  sourceLabel: string;
  /** Non-secret identity used to notice that Codex rotated/replaced a login. */
  fingerprint: string;
}

export class NoCodexCredentialsError extends Error {
  constructor() {
    super("No ChatGPT Codex sign-in found on this machine.");
    this.name = "NoCodexCredentialsError";
  }
}

export class AllCodexCredentialsRejectedError extends Error {
  constructor(public readonly rejected: string[]) {
    super(
      "The ChatGPT Codex sign-in was rejected. Sign in with Codex CLI again; " +
        "the refreshed login will be detected automatically.",
    );
    this.name = "AllCodexCredentialsRejectedError";
  }
}

export function codexAuthPaths(home = homedir(), codexHome = process.env.CODEX_HOME): string[] {
  const candidates = [
    codexHome ? join(codexHome, "auth.json") : null,
    join(home, ".codex", "auth.json"),
  ].filter((path): path is string => Boolean(path));

  const seen = new Set<string>();
  return candidates.filter((path) => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fileSource(path: string): CodexCredentialSource {
  return {
    label: path,
    read: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch {
        return null;
      }
    },
  };
}

function readCodexKeychain(): Promise<unknown> {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve(null);
    execFile(
      "security",
      ["find-generic-password", "-s", "Codex Auth", "-w"],
      { timeout: 4_000 },
      (error, stdout) => {
        if (error || !stdout) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * File-first discovery deliberately avoids cc-switch's macOS stale-Keychain
 * shadowing bug while retaining Keychain as a transparent fallback.
 */
export function codexCredentialSources(): CodexCredentialSource[] {
  return [
    ...codexAuthPaths().map(fileSource),
    { label: "macOS Keychain (Codex Auth)", read: readCodexKeychain },
  ];
}

function credentialFingerprint(source: string, token: string, accountId: string): string {
  return createHash("sha256")
    .update(source)
    .update("\0")
    .update(accountId)
    .update("\0")
    .update(token)
    .digest("hex")
    .slice(0, 16);
}

export async function currentCodexCredentialFingerprint(
  sources = codexCredentialSources(),
): Promise<string | null> {
  for (const source of sources) {
    const credential = parseCodexAuth(await source.read());
    if (!credential) continue;
    return credentialFingerprint(source.label, credential.accessToken, credential.accountId);
  }
  return null;
}

function asSnapshot(snapshot: CodexUsageSnapshot): Snapshot {
  return {
    five_hour: snapshot.five_hour,
    seven_day: snapshot.seven_day,
    limits: snapshot.limits,
  };
}

/**
 * Read-only cc-switch parity: re-read local Codex CLI credentials, call the
 * account quota endpoint once, and never refresh or write authentication data.
 */
export async function fetchCodexSnapshot(
  options: FetchCodexOptions = {},
): Promise<CodexResult> {
  const sources = options.sources ?? codexCredentialSources();
  const fetcher = options.fetcher ?? safeFetch;
  const rejected: string[] = [];
  let sawCredentials = false;

  for (const source of sources) {
    const credential = parseCodexAuth(await source.read());
    if (!credential) continue;
    sawCredentials = true;

    const response = await fetcher(CODEX_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        "ChatGPT-Account-Id": credential.accountId,
        "User-Agent": "codex-cli",
        Accept: "application/json",
      },
    });

    if (response.status === 401 || response.status === 403) {
      rejected.push(`${source.label} (${response.status})`);
      continue;
    }
    if (response.status === 429) {
      throw codedError(
        "OpenAI Codex usage is rate-limited (429).",
        429,
        retryMsFrom(
          response.headers.get("retry-after"),
          response.headers.get("x-ratelimit-reset"),
        ),
      );
    }
    if (!response.ok) {
      throw codedError(`OpenAI Codex usage check failed (${response.status}).`, response.status);
    }

    const snapshot = parseCodexUsage(await response.json(), options.nowMs);
    if (!snapshot) {
      throw new Error("OpenAI Codex returned no recognizable usage windows.");
    }

    return {
      snapshot: asSnapshot(snapshot),
      sourceLabel: source.label,
      fingerprint: credentialFingerprint(
        source.label,
        credential.accessToken,
        credential.accountId,
      ),
    };
  }

  if (!sawCredentials) throw new NoCodexCredentialsError();
  throw new AllCodexCredentialsRejectedError(rejected);
}
