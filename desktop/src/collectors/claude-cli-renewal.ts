import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UsageTracker } from "../tracker";
import type { RenewalBroker } from "./claude-oauth";

const EXPIRY_BUFFER_MS = 5 * 60_000;
/**
 * Hold ladder indexed by consecutive no-advance renewal failures. The old flat
 * 1h hold retried forever at the same cadence; escalating (1h→2h→4h→8h, capped)
 * spends fewer CLI invocations on a login that is not coming back.
 */
const FAILURE_HOLD_LADDER_MS = [
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
  8 * 60 * 60_000,
] as const;
/**
 * After this many consecutive no-advance failures the login is treated as dead
 * (rotated/flagged): the scheduler stops spending usage-endpoint calls on it
 * and surfaces an actionable "renew your sign-in" state until a fresh login
 * appears on disk. Per the project's hard-won rule, only a real browser sign-in
 * clears a dead login — looping the CLI forever would only deepen the flag.
 */
const RELOGIN_STREAK_THRESHOLD = 3;
const LOGIN_TIMEOUT_MS = 30_000;
const LOCK_WAIT_MS = LOGIN_TIMEOUT_MS + 10_000;
const LOCK_STALE_MS = LOGIN_TIMEOUT_MS + 30_000;
const LOCK_POLL_MS = 250;

interface OAuthEntry {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
}

export interface ClaudeCliLoginRequest {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ClaudeCliLoginResult {
  code: number;
  timedOut?: boolean;
  /** Captured so a failure is attributable instead of a bare `exitCode:1`. */
  stdout?: string;
  stderr?: string;
}

export interface ClaudeCliRenewalState {
  /** One-way digest only. Raw OAuth material is never persisted here. */
  fingerprint?: string;
  blockedUntil?: number;
  lastAttemptAt?: number;
  lastOkAt?: number;
  /** Consecutive no-advance renewal failures. Indexes the hold ladder. */
  streak?: number;
  /** True once `streak` crosses RELOGIN_STREAK_THRESHOLD — login presumed dead. */
  requiresRelogin?: boolean;
}

interface ClaudeCliRenewalDeps {
  now?: () => number;
  run?: (request: ClaudeCliLoginRequest) => Promise<ClaudeCliLoginResult>;
  readCredentials?: (path: string) => Promise<unknown>;
  withLock?: (
    path: string,
    task: () => Promise<string | null>,
  ) => Promise<string | null>;
  tracker?: Pick<UsageTracker, "event">;
  initialState?: Record<string, unknown>;
}

function oauthEntryOf(credentials: unknown): OAuthEntry | null {
  if (!credentials || typeof credentials !== "object") return null;
  const record = credentials as Record<string, unknown>;
  return (record.claudeAiOauth || record["claude.ai_oauth"] || null) as OAuthEntry | null;
}

function tokenFingerprint(oauth: OAuthEntry): string {
  return createHash("sha256")
    .update(oauth.accessToken || "")
    .update("\0")
    .update(oauth.refreshToken || "")
    .digest("hex")
    .slice(0, 20);
}

function isFresh(oauth: OAuthEntry, now: number): boolean {
  return Boolean(
    oauth.accessToken &&
      typeof oauth.expiresAt === "number" &&
      oauth.expiresAt > now + EXPIRY_BUFFER_MS,
  );
}

async function defaultReadCredentials(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function defaultRun(request: ClaudeCliLoginRequest): Promise<ClaudeCliLoginResult> {
  return new Promise((resolve) => {
    execFile(
      request.command,
      request.args,
      {
        env: request.env,
        timeout: request.timeoutMs,
        windowsHide: true,
        // Windows cannot exec a .cmd shim directly. The command and arguments
        // are fixed constants; OAuth secrets remain exclusively in env.
        shell: process.platform === "win32",
        maxBuffer: 256 * 1024,
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const tail = typeof stderr === "string" ? stderr : "";
        const result = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        if (!error) return resolve({ code: 0, stdout: out, stderr: tail });
        resolve({
          code: typeof result.code === "number" ? result.code : 1,
          timedOut: Boolean(result.killed || result.signal === "SIGTERM"),
          stdout: out,
          stderr: tail,
        });
      },
    );
  });
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(path: string, now: number): Promise<boolean> {
  try {
    const details = JSON.parse(await readFile(path, "utf8")) as {
      pid?: number;
      startedAt?: number;
    };
    const age = now - (details.startedAt || (await stat(path)).mtimeMs);
    if (age <= LOCK_STALE_MS) return false;
    if (typeof details.pid !== "number") return true;
    return !(await processExists(details.pid));
  } catch {
    try {
      return now - (await stat(path)).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

async function defaultWithLock(
  credentialsPath: string,
  task: () => Promise<string | null>,
): Promise<string | null> {
  const lockPath = join(dirname(credentialsPath), ".duitsini-claude-renew.lock");
  const nonce = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: Date.now(), nonce }),
          "utf8",
        );
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockIsStale(lockPath, Date.now())) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the Claude credential renewal lock.");
      }
      await wait(LOCK_POLL_MS);
    }
  }

  try {
    return await task();
  } finally {
    try {
      const details = JSON.parse(await readFile(lockPath, "utf8")) as { nonce?: string };
      if (details.nonce === nonce) await unlink(lockPath);
    } catch {
      // A lock that no longer belongs to this process must not be removed.
    }
  }
}

/**
 * Renews dedicated Claude profiles by delegating the OAuth exchange to the
 * installed official Claude CLI. This class never calls Anthropic's token
 * endpoint itself and never places OAuth secrets in command-line arguments.
 */
export class ClaudeCliRenewalManager implements RenewalBroker {
  private readonly now: () => number;
  private readonly run: (request: ClaudeCliLoginRequest) => Promise<ClaudeCliLoginResult>;
  private readonly readCredentials: (path: string) => Promise<unknown>;
  private readonly withLock: (
    path: string,
    task: () => Promise<string | null>,
  ) => Promise<string | null>;
  private readonly tracker?: Pick<UsageTracker, "event">;
  private readonly states: Record<string, ClaudeCliRenewalState>;
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(deps: ClaudeCliRenewalDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.run = deps.run ?? defaultRun;
    this.readCredentials = deps.readCredentials ?? defaultReadCredentials;
    this.withLock = deps.withLock ?? defaultWithLock;
    this.tracker = deps.tracker;
    this.states = structuredClone(deps.initialState ?? {}) as Record<string, ClaudeCliRenewalState>;
  }

  exportState(): Record<string, ClaudeCliRenewalState> {
    return structuredClone(this.states);
  }

  /**
   * Path of a dedicated profile whose login is presumed dead (renewal exhausted
   * the streak). The scheduler uses this to STOP spending usage-endpoint calls
   * on a token that cannot be refreshed — that volume is itself the account-
   * keyed 429 risk — and to surface an actionable state instead.
   */
  terminalPath(): string | undefined {
    for (const [path, state] of Object.entries(this.states)) {
      if (state.requiresRelogin) return path;
    }
    return undefined;
  }

  /**
   * For a terminal path, read the credentials file and detect a FRESH external
   * sign-in (fingerprint changed AND the token is usable). Clears the dead-
   * login state so normal collection resumes; returns false while the same dead
   * login is still on disk so the caller keeps skipping the network call.
   */
  async externalReloginDetected(path: string): Promise<boolean> {
    const state = this.states[path];
    if (!state?.requiresRelogin) return false;
    const oauth = oauthEntryOf(await this.readCredentials(path));
    if (!oauth?.accessToken) return false;
    const fingerprint = tokenFingerprint(oauth);
    if (fingerprint === state.fingerprint || !isFresh(oauth, this.now())) return false;
    delete state.blockedUntil;
    state.fingerprint = fingerprint;
    state.streak = 0;
    state.requiresRelogin = false;
    state.lastOkAt = this.now();
    return true;
  }

  async renewIfNeeded(
    credentials: unknown,
    path: string,
    options: { force?: boolean } = {},
  ): Promise<string | null> {
    const oauth = oauthEntryOf(credentials);
    if (!oauth?.accessToken) return null;
    const now = this.now();
    const fingerprint = tokenFingerprint(oauth);
    const state = (this.states[path] ??= {});

    if (state.fingerprint && state.fingerprint !== fingerprint) {
      // A fresh login (manual browser sign-in, or another tool) replaces a dead
      // one: clear every consequence of the previous login's failure streak.
      delete state.blockedUntil;
      state.streak = 0;
      state.requiresRelogin = false;
    }
    state.fingerprint = fingerprint;

    if (!options.force && isFresh(oauth, now)) return oauth.accessToken;
    if ((state.blockedUntil ?? 0) > now) return oauth.accessToken;
    if (!oauth.refreshToken) {
      this.hold(path, fingerprint, now);
      this.track("cli_renew_unavailable", path, oauth, { reason: "missing_refresh_token" });
      return oauth.accessToken;
    }

    const pending = this.inFlight.get(path);
    if (pending) return pending;

    const renewal = this.withLock(path, async () => {
      const latestCredentials = await this.readCredentials(path);
      const latest = oauthEntryOf(latestCredentials) ?? oauth;
      const latestFingerprint = tokenFingerprint(latest);

      // Another DuitSini process or Claude CLI may have renewed while we waited.
      if (latestFingerprint !== fingerprint && isFresh(latest, this.now())) {
        this.states[path] = {
          fingerprint: latestFingerprint,
          lastOkAt: this.now(),
        };
        return latest.accessToken ?? oauth.accessToken!;
      }

      if (!latest.refreshToken) {
        this.hold(path, latestFingerprint, this.now());
        this.track("cli_renew_unavailable", path, latest, { reason: "missing_refresh_token" });
        return latest.accessToken ?? oauth.accessToken!;
      }

      const attemptAt = this.now();
      const activeState = (this.states[path] ??= {});
      activeState.fingerprint = latestFingerprint;
      activeState.lastAttemptAt = attemptAt;
      this.track("cli_renew_start", path, latest);

      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_BASE_URL;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.CLAUDE_CODE_USE_VERTEX;
      delete env.CLAUDE_CODE_USE_FOUNDRY;
      env.CLAUDE_CONFIG_DIR = dirname(path);
      env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = latest.refreshToken;
      env.CLAUDE_CODE_OAUTH_SCOPES = (latest.scopes ?? []).join(" ");

      let result: ClaudeCliLoginResult;
      try {
        result = await this.run({
          command: process.platform === "win32" ? "claude.cmd" : "claude",
          args: ["auth", "login", "--claudeai"],
          env,
          timeoutMs: LOGIN_TIMEOUT_MS,
        });
      } catch {
        result = { code: 1 };
      }

      // The CLI may rotate the credentials on disk and STILL exit non-zero (a
      // post-write warning, a signal, telemetry shutdown). The file is ground
      // truth: inspect it on EVERY termination and credit the rotation
      // regardless of exit code. Only record a failure when the exchange
      // produced no usable new token — this is what stops a "rotated-but-
      // exited-1" renewal from mis-lighting the failure streak (and, eventually,
      // the dead-login state), which is the bug that silently bricked the
      // tracker after the rotation chain broke.
      const rotatedCredentials = await this.readCredentials(path);
      const rotated = oauthEntryOf(rotatedCredentials);
      const rotatedFingerprint = rotated ? tokenFingerprint(rotated) : null;
      const expiryAdvanced =
        Boolean(rotated?.accessToken) &&
        rotatedFingerprint !== latestFingerprint &&
        typeof rotated?.expiresAt === "number" &&
        rotated.expiresAt > (latest.expiresAt ?? 0) &&
        rotated.expiresAt > this.now() + EXPIRY_BUFFER_MS;

      if (rotated && rotatedFingerprint && expiryAdvanced) {
        // The token was refreshed — even if the subprocess exited non-zero.
        // The login is healthy again; reset the failure streak.
        this.states[path] = {
          fingerprint: rotatedFingerprint,
          lastAttemptAt: attemptAt,
          lastOkAt: this.now(),
          streak: 0,
          requiresRelogin: false,
        };
        this.track("cli_renew_ok", path, rotated);
        return rotated.accessToken!;
      }

      // No advance. Hold, bump the streak (escalating the next hold and, once
      // it crosses the threshold, marking the login dead), and record why —
      // including the captured stderr so the next failure is attributable
      // instead of a bare, undiagnostic `exitCode:1`.
      const nominalExit = result.code === 0 && !result.timedOut;
      this.hold(path, latestFingerprint, this.now());
      this.track(nominalExit ? "cli_renew_invalid_result" : "cli_renew_fail", path, latest, {
        exitCode: result.code,
        timedOut: Boolean(result.timedOut),
        ...(result.stderr ? { stderr: result.stderr.slice(-1000) } : {}),
        ...(result.stdout ? { stdout: result.stdout.slice(-1000) } : {}),
      });
      return latest.accessToken ?? oauth.accessToken!;
    });

    this.inFlight.set(path, renewal);
    try {
      return await renewal;
    } finally {
      if (this.inFlight.get(path) === renewal) this.inFlight.delete(path);
    }
  }

  private hold(path: string, fingerprint: string, now: number): void {
    const state = (this.states[path] ??= {});
    state.fingerprint = fingerprint;
    const streak = (state.streak ?? 0) + 1;
    state.streak = streak;
    const holdMs =
      FAILURE_HOLD_LADDER_MS[Math.min(streak, FAILURE_HOLD_LADDER_MS.length) - 1];
    state.blockedUntil = now + holdMs;
    if (streak >= RELOGIN_STREAK_THRESHOLD) state.requiresRelogin = true;
  }

  private track(
    type: string,
    path: string,
    oauth: OAuthEntry,
    extra: Record<string, unknown> = {},
  ): void {
    this.tracker?.event(type, {
      source: path,
      fingerprint: tokenFingerprint(oauth),
      expiresAt: oauth.expiresAt ?? null,
      ...extra,
    });
  }
}
