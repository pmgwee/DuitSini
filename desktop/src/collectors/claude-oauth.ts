import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import {
  UA,
  USAGE_ENDPOINT,
  claudeCredCandidates,
  generalTailStart,
} from "../config";
import { retryMsFrom, safeFetch } from "../net";
import type { UsageTracker } from "../tracker";
import { codedError, type Snapshot, type UsageLimit, type UsageWindow } from "../types";

/**
 * Claude subscription usage — read-only public path, official-CLI dedicated path.
 *
 * WHY THIS SHAPE. cc-switch never suffers the sharer's rate-limit problems, and
 * its `subscription.rs` says why in one line: "第一层：仅读取凭据，不实现登录/刷新"
 * (layer 1: only reads credentials, does not implement login/refresh). It reads
 * the LIVE `~/.claude` store that Claude Code itself keeps fresh as a side
 * effect of normal use, so it issues zero refresh POSTs and can never be flagged
 * for them.
 *
 * The sharer cannot do that, because it reads DEDICATED dirs (`~/.claude-pro`,
 * `~/.claude-sub`) that exist precisely so the tracked account differs from the
 * one the member's Claude Code is pointed at. Nothing else maintains those, so
 * the sharer had to refresh them itself — and that traffic is what produced the
 * refresh-429 ladders and the ~8h token death across v3→v7.
 *
 * So this app does BOTH, in strict priority order:
 *
 *   1. Use whatever token is on disk, AS-IS. When any source is being kept fresh
 *      by Claude Code, this is the only path taken and we behave exactly like
 *      cc-switch — zero refresh calls.
 *   2. Only when a token is actually at/past expiry (or a real 401 comes back)
 *      does `ClaudeCliRenewalManager` invoke the installed official CLI once.
 *      DuitSini never calls the OAuth token endpoint or writes credentials.
 *
 * The candidate walk also self-heals: a stale dedicated token answers 401 and
 * the walk advances to a live source before any refresh is considered.
 */

interface OAuthEntry {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface CredSource {
  label: string;
  /** File path, or null for the Keychain (which nothing can write a rotation back to). */
  path: string | null;
  /** Dedicated secondary profiles are the only sources eligible for brokered renewal. */
  dedicated: boolean;
  read: () => Promise<unknown>;
}

/** Both spellings appear in the wild depending on which tool wrote the file. */
function oauthEntryOf(creds: unknown): OAuthEntry | null {
  if (!creds || typeof creds !== "object") return null;
  const c = creds as Record<string, unknown>;
  return (c.claudeAiOauth || c["claude.ai_oauth"] || null) as OAuthEntry | null;
}

function readKeychainCreds(): Promise<unknown> {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve(null);
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
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
 * Candidate order: dedicated dirs → macOS Keychain → general dirs. Mirrors the
 * sharer's `proCredSources` so a member's existing setup keeps its meaning.
 */
export function credSources(): CredSource[] {
  const paths = claudeCredCandidates();
  const tailStart = generalTailStart(paths);
  const fileSource = (p: string, dedicated: boolean): CredSource => ({
    label: p,
    path: p,
    dedicated,
    read: async () => {
      try {
        return JSON.parse(await readFile(p, "utf8"));
      } catch {
        return null;
      }
    },
  });

  const out: CredSource[] = [];
  for (let i = 0; i < tailStart; i++) out.push(fileSource(paths[i]!, true));
  out.push({ label: "macOS Keychain", path: null, dedicated: false, read: readKeychainCreds });
  for (let i = tailStart; i < paths.length; i++) out.push(fileSource(paths[i]!, false));
  return out;
}

function pickWindow(w: unknown): UsageWindow | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  if (typeof o.utilization !== "number") return null;
  return { utilization: o.utilization, resets_at: (o.resets_at as string) || null };
}

function normLimits(usage: Record<string, unknown>): UsageLimit[] | null {
  if (!Array.isArray(usage.limits)) return null;
  return (usage.limits as Record<string, unknown>[]).map((l) => {
    let key: string;
    let label: string;
    if (l.kind === "session") {
      key = "session";
      label = "Current session";
    } else if (l.kind === "weekly_all") {
      key = "weekly_all";
      label = "All models";
    } else if (l.kind === "weekly_scoped") {
      const scope = l.scope as { model?: { display_name?: string } } | undefined;
      const m = scope?.model?.display_name || "Scoped";
      key = `weekly:${m}`;
      label = m;
    } else {
      key = (l.kind as string) || "unknown";
      label = (l.kind as string) || "Unknown";
    }
    return {
      key,
      label,
      group: l.group === "session" ? "session" : "weekly",
      percent: typeof l.percent === "number" ? l.percent : null,
      resets_at: (l.resets_at as string) || null,
      severity: (l.severity as string) || null,
    } satisfies UsageLimit;
  });
}

/** Raised when no candidate held usable credentials at all. */
export class NoCredentialsError extends Error {
  constructor() {
    super("No Claude sign-in found on this machine.");
    this.name = "NoCredentialsError";
  }
}

/** Raised when credentials existed but every one was rejected by the server. */
export class AllRejectedError extends Error {
  constructor(public readonly rejected: string[]) {
    super(
      "Every Claude sign-in on this machine was rejected. Sign in to Claude Code with your " +
        "Claude Pro/Max account again — a fresh login is picked up automatically.",
    );
    this.name = "AllRejectedError";
  }
}

async function fetchUsage(
  token: string,
  /** Counts the ATTEMPT (the account-keyed window counts every request, including 401/429) and returns the new daily count. */
  onCall: () => number,
  ctx: { source: string; expiresAt?: number },
  tracker?: UsageTracker,
  fetcher: typeof safeFetch = safeFetch,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const callsToday = onCall();
  tracker?.event("usage_call", {
    source: ctx.source,
    expiresAt: ctx.expiresAt ?? null,
    minsToExpiry: typeof ctx.expiresAt === "number" ? Math.round((ctx.expiresAt - now) / 60_000) : null,
    alreadyExpired: typeof ctx.expiresAt === "number" ? now > ctx.expiresAt : null,
    callsToday,
  });

  const r = await fetcher(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": UA,
      "Content-Type": "application/json",
    },
  });

  const retryAfter = r.headers.get("retry-after");
  const reset =
    r.headers.get("anthropic-ratelimit-unified-reset") || r.headers.get("x-ratelimit-reset");
  const minsToExpiry =
    typeof ctx.expiresAt === "number" ? Math.round((ctx.expiresAt - now) / 60_000) : null;

  if (r.status === 401) {
    tracker?.event("usage_401", { source: ctx.source, callsToday, minsToExpiry, retryAfter, reset });
    throw codedError("Sign-in rejected by the server.", 401);
  }
  if (r.status === 403) {
    tracker?.event("usage_403", { source: ctx.source, callsToday, retryAfter, reset });
    throw codedError("Usage is only available on a Claude Pro or Max plan.", 403);
  }
  if (r.status === 429) {
    let detail = "";
    try {
      detail = (await r.text()).slice(0, 200);
    } catch {
      /* body may be empty */
    }
    tracker?.event("usage_429", { source: ctx.source, callsToday, retryAfter, reset, body: detail });
    throw codedError(
      `Anthropic usage rate-limited (429)${retryAfter ? ` retry-after=${retryAfter}s` : ""}${detail ? ` body=${detail.slice(0, 160)}` : ""}`,
      429,
      retryMsFrom(retryAfter, reset),
    );
  }
  if (!r.ok) {
    let detail = "";
    try {
      detail = (await r.text()).slice(0, 200);
    } catch {
      /* body may be empty */
    }
    tracker?.event("usage_error", { source: ctx.source, status: r.status, callsToday, body: detail });
    throw new Error(`Usage check failed (${r.status}).`);
  }
  tracker?.event("usage_ok", { source: ctx.source, callsToday, minsToExpiry });
  return (await r.json()) as Record<string, unknown>;
}

export interface ProResult {
  snapshot: Snapshot;
  /** Which credential source served this snapshot — surfaced in the UI. */
  sourceLabel: string;
}

interface DedicatedRenewalBroker {
  renewIfNeeded(
    creds: unknown,
    path: string,
    options?: { force?: boolean },
  ): Promise<string | null>;
}

/**
 * A renewal strategy for dedicated Claude profiles. `ClaudeCliRenewalManager`
 * (default, `claude auth login`) and `RefreshManager` (F5, direct token-endpoint
 * POST) both implement this; the scheduler picks one via `renewalMode()`. The
 * credential walk only needs `renewIfNeeded`; the scheduler uses the rest for
 * the F3 dead-login stop and F4 one-click recovery floor.
 */
export interface RenewalBroker extends DedicatedRenewalBroker {
  exportState(): Record<string, unknown>;
  /** Path of a profile whose login is dead and must not be hammered. */
  terminalPath(): string | undefined;
  /** True once a fresh external sign-in has landed for a terminal path. */
  externalReloginDetected(path: string): Promise<boolean>;
}

export interface FetchProOptions {
  sources?: CredSource[];
  fetcher?: typeof safeFetch;
}

function renewDedicated(
  broker: DedicatedRenewalBroker,
  creds: unknown,
  path: string,
  force = false,
): Promise<string | null> {
  return broker.renewIfNeeded(creds, path, { force });
}

/**
 * Walk the credential candidates and return the first snapshot a live token
 * produces.
 *
 *   401 / 403 → this login cannot serve usage. For a refresh-capable FILE
 *               source a 401 buys one forced, gated refresh and a single retry
 *               (the server may have retired the token before its recorded
 *               expiry); otherwise advance to the next candidate.
 *   429       → STOP. Throttling is endpoint-level, so trying further
 *               candidates would multiply pressure on an already-flagged
 *               account rather than find a working one.
 *   network   → STOP. safeFetch already retried; it says nothing about tokens.
 *
 * Pass `renewal` to enable step 2 of the policy documented at the top of this
 * file. Omit it for pure cc-switch behaviour (read-only, zero refresh calls).
 */
export async function fetchProSnapshot(
  onCall: () => number,
  renewal?: DedicatedRenewalBroker,
  tracker?: UsageTracker,
  options: FetchProOptions = {},
): Promise<ProResult> {
  let sawCreds = false;
  const rejected: string[] = [];

  for (const src of options.sources ?? credSources()) {
    const creds = await src.read();
    const oauth = oauthEntryOf(creds);
    if (!oauth?.accessToken) continue;
    sawCreds = true;

    // Piggyback path: a token that is still valid is used verbatim and costs
    // nothing. The dedicated renewal broker acts only near real expiry and
    // degrades to the current token on every gate, so this never throws.
    const token =
      renewal && src.path && src.dedicated
        ? ((await renewDedicated(renewal, creds, src.path)) ?? oauth.accessToken)
        : oauth.accessToken;

    const snapshotFrom = (usage: Record<string, unknown>): Snapshot => ({
      five_hour: pickWindow(usage.five_hour),
      seven_day: pickWindow(usage.seven_day),
      limits: normLimits(usage),
    });

    try {
      return {
        snapshot: snapshotFrom(
          await fetchUsage(
            token,
            onCall,
            { source: src.label, expiresAt: oauth.expiresAt },
            tracker,
            options.fetcher,
          ),
        ),
        sourceLabel: src.label,
      };
    } catch (e) {
      const code = (e as { code?: number | string }).code;
      if (code !== 401 && code !== 403) throw e;

      // Reactive path: a 401 can mean the server retired this token EARLIER than
      // its recorded expiry. Spend at most one forced refresh and retry once —
      // all gates still apply, so a dead login costs one POST per hold window,
      // never one per cycle.
      if (code === 401 && renewal && src.path && src.dedicated && oauth.refreshToken) {
        const forced = await renewDedicated(renewal, creds, src.path, true);
        if (forced && forced !== token) {
          try {
            return {
              snapshot: snapshotFrom(
                await fetchUsage(
                  forced,
                  onCall,
                  { source: src.label, expiresAt: oauth.expiresAt },
                  tracker,
                  options.fetcher,
                ),
              ),
              sourceLabel: src.label,
            };
          } catch (retryErr) {
            const retryCode = (retryErr as { code?: number | string }).code;
            if (retryCode !== 401 && retryCode !== 403) throw retryErr;
          }
        }
      }

      rejected.push(`${src.label} (${code})`);
    }
  }

  if (!sawCreds) throw new NoCredentialsError();
  throw new AllRejectedError(rejected);
}
