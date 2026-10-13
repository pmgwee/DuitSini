import { z } from "zod";
import type { UsageWindow as LiveUsageWindow, UsageLimit, UsageStream } from "./protocol";

/**
 * Google AI Pro (Antigravity coding allowance) usage tracking parser and adapter.
 *
 * Scope: Antigravity coding quota only. Not 5 TB Google Drive storage, Gemini API billing,
 * AI Studio API tokens, Google Cloud credits, or context-window occupancy.
 */

export const GOOGLE_GEMINI_SOURCE = "google_gemini";
export const GOOGLE_CLAUDE_SOURCE = "google_claude";

export const GOOGLE_GEMINI_LABEL = "Google AI Pro · Gemini";
export const GOOGLE_CLAUDE_LABEL = "Google AI Pro · Claude + GPT-OSS";

export interface QuotaBucketData {
  remaining_fraction?: number | null;
  reset_time?: string | null;
  reset_in_seconds?: number | null;
}

export interface SanitizedAntigravitySnapshot {
  product: string;
  version?: string | null;
  email?: string | null;
  plan_tier?: string | null;
  observed_at: string;
  quota: Record<string, QuotaBucketData>;
}

export interface WindowReading {
  utilization: number | null;
  resets_at: string | null;
}

export interface GoogleQuotaPools {
  gemini: {
    five_hour: WindowReading | null;
    weekly: WindowReading | null;
  };
  claudePartner: {
    five_hour: WindowReading | null;
    weekly: WindowReading | null;
  };
  email?: string | null;
  planTier?: string | null;
  observedAt: string;
}

/**
 * Validates remaining fraction and converts to percent used:
 * usedPercent = (1 - remaining_fraction) * 100
 *
 * Full remaining (1.0) = 0% used.
 * Zero remaining (0.0) = 100% used.
 * Null/undefined/NaN/out of [0, 1] range = null (unavailable).
 */
export function fractionToPercentUsed(fraction: unknown): number | null {
  if (fraction === null || fraction === undefined || typeof fraction !== "number" || Number.isNaN(fraction)) {
    return null;
  }
  // Tolerate small floating point slop e.g. 1.000001 or -0.000001
  if (fraction < -0.001 || fraction > 1.001) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, fraction));
  const used = (1 - clamped) * 100;
  return Math.round(used * 10) / 10;
}

/**
 * Converts remaining percentage string or number (e.g. "95%" or 95) to percent used:
 * 100% remaining -> 0% used
 * 95% remaining -> 5% used
 */
export function remainingPercentToPercentUsed(remainingPct: unknown): number | null {
  let val: number;
  if (typeof remainingPct === "string") {
    const cleaned = remainingPct.replace("%", "").trim();
    val = Number.parseFloat(cleaned);
  } else if (typeof remainingPct === "number") {
    val = remainingPct;
  } else {
    return null;
  }
  if (Number.isNaN(val) || val < -0.1 || val > 100.1) {
    return null;
  }
  const clamped = Math.max(0, Math.min(100, val));
  return Math.round((100 - clamped) * 10) / 10;
}

/**
 * Resolves reset timestamp from provider data:
 * - Prefers provider reset_time (ISO string)
 * - Otherwise derives from reset_in_seconds relative to observedAtMs
 */
export function resolveResetTime(
  resetTime: string | null | undefined,
  resetInSeconds: number | null | undefined,
  observedAtMs: number,
): string | null {
  if (resetTime && typeof resetTime === "string") {
    const parsed = Date.parse(resetTime);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (typeof resetInSeconds === "number" && Number.isFinite(resetInSeconds) && resetInSeconds >= 0) {
    return new Date(observedAtMs + resetInSeconds * 1000).toISOString();
  }
  return null;
}

/**
 * Sanitizes incoming statusline JSON from Antigravity CLI stdin.
 * Discards transcript paths, workspace folders, conversation IDs, and context window details.
 */
export function sanitizeAntigravityStatusLine(
  raw: unknown,
  fallbackObservedAt: number = Date.now(),
): SanitizedAntigravitySnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const product = typeof obj.product === "string" ? obj.product : "antigravity";
  const version = typeof obj.version === "string" ? obj.version : null;
  const email = typeof obj.email === "string" && obj.email.includes("@") ? obj.email.trim() : null;
  const plan_tier = typeof obj.plan_tier === "string" ? obj.plan_tier : null;
  const observed_at = new Date(fallbackObservedAt).toISOString();

  const quotaObj = (obj.quota && typeof obj.quota === "object" ? obj.quota : {}) as Record<string, unknown>;
  const quota: Record<string, QuotaBucketData> = {};

  for (const [key, val] of Object.entries(quotaObj)) {
    if (!val || typeof val !== "object") continue;
    const b = val as Record<string, unknown>;
    const remaining_fraction =
      typeof b.remaining_fraction === "number" && Number.isFinite(b.remaining_fraction)
        ? b.remaining_fraction
        : null;
    const reset_time = typeof b.reset_time === "string" ? b.reset_time : null;
    const reset_in_seconds =
      typeof b.reset_in_seconds === "number" && Number.isFinite(b.reset_in_seconds)
        ? b.reset_in_seconds
        : null;

    quota[key] = {
      remaining_fraction,
      reset_time,
      reset_in_seconds,
    };
  }

  return {
    product,
    version,
    email,
    plan_tier,
    observed_at,
    quota,
  };
}

/**
 * Extracts the 4 distinct quota windows from a sanitized snapshot or quota map.
 * Buckets:
 *  - gemini-5h (Gemini session)
 *  - gemini-weekly (Gemini weekly)
 *  - 3p-5h (Claude/GPT session)
 *  - 3p-weekly (Claude/GPT weekly)
 */
export function parseQuotaBuckets(snapshot: SanitizedAntigravitySnapshot): GoogleQuotaPools {
  const observedAtMs = Date.parse(snapshot.observed_at) || Date.now();
  const q = snapshot.quota;

  const extractWindow = (bucketKey: string, altKeys: string[] = []): WindowReading | null => {
    const bucket = q[bucketKey] ?? altKeys.map((k) => q[k]).find(Boolean);
    if (!bucket) return null;
    const utilization = fractionToPercentUsed(bucket.remaining_fraction);
    const resets_at = resolveResetTime(bucket.reset_time, bucket.reset_in_seconds, observedAtMs);
    if (utilization === null && resets_at === null) return null;
    return { utilization, resets_at };
  };

  const gemini5h = extractWindow("gemini-5h", ["gemini_5h", "gemini-session"]);
  const geminiWeekly = extractWindow("gemini-weekly", ["gemini_weekly"]);
  const partner5h = extractWindow("3p-5h", ["3p_5h", "claude-5h", "claude_5h"]);
  const partnerWeekly = extractWindow("3p-weekly", ["3p_weekly", "claude-weekly", "claude_weekly"]);

  return {
    gemini: {
      five_hour: gemini5h,
      weekly: geminiWeekly,
    },
    claudePartner: {
      five_hour: partner5h,
      weekly: partnerWeekly,
    },
    email: snapshot.email,
    planTier: snapshot.plan_tier,
    observedAt: snapshot.observed_at,
  };
}

/**
 * Parses manual output copied from `agy -p "/usage"` (tab-separated or space-separated):
 * Example:
 * Gemini Models	Weekly Limit Remaining	100%	2026-10-19T16:32:31Z
 * Gemini Models	Five Hour Limit Remaining	100%	2026-10-12T21:32:31Z
 * Claude and GPT models	Weekly Limit Remaining	100%	2026-10-19T16:32:31Z
 * Claude and GPT models	Five Hour Limit Remaining	100%	2026-10-12T21:32:31Z
 *
 * Also parses JSON output if the user pasted JSON.
 */
export function parseManualUsageImport(
  rawText: string,
  nowMs: number = Date.now(),
): GoogleQuotaPools | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // Try JSON first (e.g. from `agy -p "/usage" --output-format json` or settings dump)
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      // Check if it's the full command output
      const cmdData = (obj.command as { data?: { groups?: Array<{ name: string; buckets: Array<Record<string, unknown>> }> } })?.data;
      if (cmdData?.groups && Array.isArray(cmdData.groups)) {
        const quota: Record<string, QuotaBucketData> = {};
        for (const grp of cmdData.groups) {
          for (const b of grp.buckets ?? []) {
            if (typeof b.id === "string") {
              quota[b.id] = {
                remaining_fraction: typeof b.remaining_fraction === "number" ? b.remaining_fraction : null,
                reset_time: typeof b.reset_time === "string" ? b.reset_time : null,
                reset_in_seconds: typeof b.reset_in_seconds === "number" ? b.reset_in_seconds : null,
              };
            }
          }
        }
        return parseQuotaBuckets({
          product: "antigravity",
          observed_at: new Date(nowMs).toISOString(),
          quota,
        });
      }

      // Check if it has a direct quota object
      if (obj.quota && typeof obj.quota === "object") {
        const sanitized = sanitizeAntigravityStatusLine(obj, nowMs);
        if (sanitized) return parseQuotaBuckets(sanitized);
      }
    } catch {
      // Fall through to text TSV parsing
    }
  }

  // Parse TSV lines
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let gemini5h: WindowReading | null = null;
  let geminiWeekly: WindowReading | null = null;
  let partner5h: WindowReading | null = null;
  let partnerWeekly: WindowReading | null = null;

  for (const line of lines) {
    const parts = line.split(/\t+/).map((p) => p.trim());
    if (parts.length < 3) continue;

    const group = parts[0].toLowerCase();
    const windowName = parts[1].toLowerCase();
    const percentStr = parts[2];
    const resetTime = parts[3] ? parts[3].trim() : null;

    const utilization = remainingPercentToPercentUsed(percentStr);
    const resets_at = resolveResetTime(resetTime, null, nowMs);

    const isWeekly = windowName.includes("weekly");
    const isFiveHour = windowName.includes("five") || windowName.includes("5h") || windowName.includes("session");

    if (group.includes("gemini")) {
      if (isWeekly) geminiWeekly = { utilization, resets_at };
      else if (isFiveHour) gemini5h = { utilization, resets_at };
    } else if (group.includes("claude") || group.includes("gpt") || group.includes("3p") || group.includes("partner")) {
      if (isWeekly) partnerWeekly = { utilization, resets_at };
      else if (isFiveHour) partner5h = { utilization, resets_at };
    }
  }

  if (!gemini5h && !geminiWeekly && !partner5h && !partnerWeekly) {
    return null;
  }

  return {
    gemini: {
      five_hour: gemini5h,
      weekly: geminiWeekly,
    },
    claudePartner: {
      five_hour: partner5h,
      weekly: partnerWeekly,
    },
    observedAt: new Date(nowMs).toISOString(),
  };
}

function makeStreamLimits(
  fiveHour: WindowReading | null,
  weekly: WindowReading | null,
): UsageLimit[] {
  const limits: UsageLimit[] = [];
  if (fiveHour) {
    limits.push({
      key: "session",
      label: "Current session",
      group: "session",
      percent: fiveHour.utilization,
      resets_at: fiveHour.resets_at,
      severity: null,
    });
  }
  if (weekly) {
    limits.push({
      key: "weekly_all",
      label: "Weekly",
      group: "weekly",
      percent: weekly.utilization,
      resets_at: weekly.resets_at,
      severity: null,
    });
  }
  return limits;
}

/**
 * Converts parsed Google Quota pools into two UsageStream objects for the dashboard.
 * - google_gemini: Google AI Pro · Gemini (5h + weekly)
 * - google_claude: Google AI Pro · Claude + GPT-OSS (5h + weekly)
 */
export function buildGoogleUsageStreams(
  pools: GoogleQuotaPools,
  options: {
    state?: "live" | "cached" | "auth_stale" | "offline";
    statusMessage?: string | null;
    deviceId?: string | null;
  } = {},
): UsageStream[] {
  const { state = "live", statusMessage = null, deviceId = null } = options;

  const streams: UsageStream[] = [];

  // Stream 1: Gemini pool
  const geminiLimits = makeStreamLimits(pools.gemini.five_hour, pools.gemini.weekly);
  if (pools.gemini.five_hour || pools.gemini.weekly) {
    streams.push({
      source: GOOGLE_GEMINI_SOURCE,
      label: GOOGLE_GEMINI_LABEL,
      account_email: pools.email ?? null,
      plan_type: pools.planTier ?? "Pro",
      device_id: deviceId,
      five_hour: pools.gemini.five_hour,
      seven_day: pools.gemini.weekly,
      limits: geminiLimits,
      provider: {
        name: "Google Antigravity",
        gateway_host: null,
        official: true,
      },
      cached: state === "cached",
      observed_at: pools.observedAt,
      state,
      status_message: statusMessage,
    });
  }

  // Stream 2: Claude + GPT-OSS partner pool
  const partnerLimits = makeStreamLimits(pools.claudePartner.five_hour, pools.claudePartner.weekly);
  if (pools.claudePartner.five_hour || pools.claudePartner.weekly) {
    streams.push({
      source: GOOGLE_CLAUDE_SOURCE,
      label: GOOGLE_CLAUDE_LABEL,
      account_email: pools.email ?? null,
      plan_type: pools.planTier ?? "Pro",
      device_id: deviceId,
      five_hour: pools.claudePartner.five_hour,
      seven_day: pools.claudePartner.weekly,
      limits: partnerLimits,
      provider: {
        name: "Google Antigravity",
        gateway_host: null,
        official: true,
      },
      cached: state === "cached",
      observed_at: pools.observedAt,
      state,
      status_message: statusMessage,
    });
  }

  return streams;
}
