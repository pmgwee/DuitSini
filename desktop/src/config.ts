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

export const CC_SWITCH_DIR = join(homedir(), ".cc-switch");
export const CC_SWITCH_DB = join(CC_SWITCH_DIR, "cc-switch.db");
export const CC_SWITCH_JSON = join(CC_SWITCH_DIR, "config.json");

/**
 * How a dedicated Claude profile (~/.claude-pro) is kept alive. A switch, not a
 * layer — only one mode is ever active on a given credentials file.
 *
 *   direct-post (default) — a single direct `grant_type=refresh_token` POST,
 *                           the v7 discipline. A serialized single-poster
 *                           refresh avoids the rotation/concurrency breakage
 *                           that plagues `auth login` (#25609/#24317).
 *   cli-renew             — delegate to `claude auth login --claudeai` (the
 *                           Aug 1 path; F1–F4 harden it). The revert valve: set
 *                           DUITSINI_RENEWAL_MODE=cli-renew if direct-post ever
 *                           misbehaves for a given install.
 *   off                   — pure read-only (cc-switch behaviour). No refresh
 *                           attempts at all; F4 one-click re-login is the only
 *                           recovery.
 *
 * F3 (dead-login stop) + F4 (one-click recovery) are the floor under every mode.
 */
export type RenewalMode = "cli-renew" | "direct-post" | "off";

export function renewalMode(): RenewalMode {
  const m = (process.env.DUITSINI_RENEWAL_MODE ?? "direct-post").trim();
  if (m === "cli-renew" || m === "off") return m;
  return "direct-post";
}

/** Claude Code session transcripts — the zero-network estimate's input. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Credential candidates, in the sharer's v5 order: dedicated dirs first (a
 * member may deliberately track a Claude account that is NOT the one their main
 * Claude Code is pointed at), then the general ones.
 *
 * Ordinary/general sources are always read-only and self-heal through the
 * candidate walk. Dedicated sources are the only entries the scheduler may
 * renew through the installed official Claude CLI.
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
