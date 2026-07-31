import type { UsageLimit, UsageWindow } from "./protocol";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_FIVE_HOUR_SECONDS = 18_000;
export const CODEX_SEVEN_DAY_SECONDS = 604_800;
export const CODEX_THIRTY_DAY_SECONDS = 2_592_000;

export type CodexCredential = {
  accessToken: string;
  accountId: string;
  lastRefresh: string | null;
};

export type CodexUsageSnapshot = {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  limits: UsageLimit[];
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseCodexAuth(value: unknown): CodexCredential | null {
  const root = asRecord(value);
  const tokens = asRecord(root?.tokens);
  if (root?.auth_mode !== "chatgpt" || !tokens) return null;

  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id.trim() : "";
  if (!accessToken || !accountId) return null;

  return {
    accessToken,
    accountId,
    lastRefresh: typeof root.last_refresh === "string" ? root.last_refresh : null,
  };
}

type ParsedWindow = {
  durationSeconds: number;
  window: Exclude<UsageWindow, null>;
  limit: UsageLimit;
};

function resetIso(window: JsonRecord, nowMs: number): string | null {
  const resetAt = finiteNumber(window.reset_at);
  const resetAfter = finiteNumber(window.reset_after_seconds);
  const timestampMs =
    resetAt !== null && resetAt >= 0
      ? resetAt * 1000
      : resetAfter !== null && resetAfter >= 0
        ? nowMs + resetAfter * 1000
        : null;
  if (timestampMs === null) return null;

  const date = new Date(timestampMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function limitIdentity(durationSeconds: number): Pick<UsageLimit, "key" | "label" | "group"> {
  if (durationSeconds === CODEX_FIVE_HOUR_SECONDS) {
    return { key: "session", label: "Current session", group: "session" };
  }
  if (durationSeconds === CODEX_SEVEN_DAY_SECONDS) {
    return { key: "weekly_all", label: "Weekly", group: "weekly" };
  }
  if (durationSeconds === CODEX_THIRTY_DAY_SECONDS) {
    return { key: "monthly_all", label: "30-day", group: "weekly" };
  }

  const hours = durationSeconds / 3600;
  const days = durationSeconds / 86_400;
  const label =
    Number.isInteger(days) && days >= 1
      ? `${days}-day`
      : Number.isInteger(hours) && hours >= 1
        ? `${hours}-hour`
        : `${durationSeconds}-second`;
  return { key: `window_${durationSeconds}`, label, group: "weekly" };
}

function parseWindow(value: unknown, nowMs: number): ParsedWindow | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const usedPercent = finiteNumber(raw.used_percent);
  const durationSeconds = finiteNumber(raw.limit_window_seconds);
  if (usedPercent === null || durationSeconds === null || durationSeconds <= 0) return null;

  const utilization = Math.min(100, Math.max(0, usedPercent));
  const resetsAt = resetIso(raw, nowMs);
  const identity = limitIdentity(durationSeconds);

  return {
    durationSeconds,
    window: { utilization, resets_at: resetsAt },
    limit: {
      ...identity,
      percent: utilization,
      resets_at: resetsAt,
      severity: null,
    },
  };
}

/**
 * Parse Codex's account quota response. `used_percent` is deliberately kept as
 * utilization so every Agent Usage ring consistently displays percent used.
 */
export function parseCodexUsage(value: unknown, nowMs = Date.now()): CodexUsageSnapshot | null {
  const root = asRecord(value);
  const rateLimit = asRecord(root?.rate_limit);
  if (!rateLimit) return null;

  const parsed = [rateLimit.primary_window, rateLimit.secondary_window]
    .map((window) => parseWindow(window, nowMs))
    .filter((window): window is ParsedWindow => window !== null)
    .filter(
      (window, index, windows) =>
        windows.findIndex((candidate) => candidate.durationSeconds === window.durationSeconds) ===
        index,
    );
  if (parsed.length === 0) return null;

  const fiveHour = parsed.find(
    (window) => window.durationSeconds === CODEX_FIVE_HOUR_SECONDS,
  );
  const sevenDay = parsed.find(
    (window) => window.durationSeconds === CODEX_SEVEN_DAY_SECONDS,
  );

  return {
    five_hour: fiveHour?.window ?? null,
    seven_day: sevenDay?.window ?? null,
    limits: parsed.map((window) => window.limit),
  };
}
