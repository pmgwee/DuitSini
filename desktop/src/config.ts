import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the shell points. This is the whole auto-sync story: the window loads
 * the deployed app, so every Vercel deploy is picked up on next launch with no
 * shell rebuild. Override for local testing with DUITSINI_APP_URL.
 */
export const APP_URL = process.env.DUITSINI_APP_URL || "https://duitsini.vercel.app";

/** Reported to the server so the live route sizes its freshness window to us. */
export const CLIENT_VERSION = "desktop-2";

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/**
 * Claude Code's own UA. The usage endpoint is an unofficial, Claude-Code-facing
 * API; sending anything else is a good way to get shaped differently.
 */
export const UA = "claude-code/2.1.9";

/**
 * Push cadence. Kept at the sharer's v6 default of 300s: the binding limiter on
 * the usage endpoint is a rolling volume window keyed to the ACCOUNT, not to the
 * transport, so moving from a script to a desktop app does not buy us headroom.
 * Clamp mirrors the sharer's (120–3600s).
 */
export const DEFAULT_PUSH_MS = 300_000;
export const MIN_PUSH_MS = 120_000;
export const MAX_PUSH_MS = 3_600_000;

/** Floor between any two pushes, regardless of what triggered them. */
export const MIN_GAP_MS = 60_000;

/** Local JSONL estimate is cheap and offline — recompute it far more often. */
export const LOCAL_ESTIMATE_MS = 60_000;

/** How long an authoritative API snapshot stays usable before we re-fetch. */
export const API_CACHE_MS = 300_000;

/** Brief resilience window for Codex when a single query fails or is throttled. */
export const CODEX_STALE_CACHE_MS = 600_000;

export const CC_SWITCH_DIR = join(homedir(), ".cc-switch");
export const CC_SWITCH_DB = join(CC_SWITCH_DIR, "cc-switch.db");
export const CC_SWITCH_JSON = join(CC_SWITCH_DIR, "config.json");

/** Claude Code session transcripts — the zero-network estimate's input. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Credential candidates, in the sharer's v5 order: dedicated dirs first (a
 * member may deliberately track a Claude account that is NOT the one their main
 * Claude Code is pointed at), then the general ones.
 *
 * Under this app's no-refresh policy the order self-heals: a dedicated dir that
 * has gone stale answers 401, the walk advances, and the live `~/.claude` store
 * — which Claude Code itself keeps fresh — serves. That is exactly why we can
 * delete the refresh layer instead of porting it.
 */
export function claudeCredCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  if (process.env.CLAUDE_SUB_CONFIG_DIR) {
    out.push(join(process.env.CLAUDE_SUB_CONFIG_DIR, ".credentials.json"));
  }
  out.push(join(home, ".claude-pro", ".credentials.json"));
  out.push(join(home, ".claude-sub", ".credentials.json"));
  if (process.env.CLAUDE_CONFIG_DIR) {
    out.push(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"));
  }
  out.push(join(home, ".claude", ".credentials.json"));
  return out;
}

/** Index at which the "general" (non-dedicated) tail begins. */
export function generalTailStart(paths: string[]): number {
  return paths.length - (process.env.CLAUDE_CONFIG_DIR ? 2 : 1);
}

export function clampPushMs(ms: number): number {
  return Math.min(MAX_PUSH_MS, Math.max(MIN_PUSH_MS, ms));
}
