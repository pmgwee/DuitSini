/**
 * Wire shapes for `/api/claude-usage/ingest`.
 *
 * These mirror the zod schema in `app/api/claude-usage/ingest/route.ts` exactly.
 * The desktop app is a drop-in replacement for the downloadable sharer, so the
 * server must not be able to tell the two apart — do not add, rename, or widen a
 * field here without changing that route first.
 */

/** One rolling window. `utilization` is a percentage (0–100), server caps at 1000. */
export interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface UsageLimit {
  key: string;
  label: string;
  group: "session" | "weekly";
  percent: number | null;
  resets_at: string | null;
  severity?: string | null;
}

/** Provider descriptor — the public subset only. Never carries a token. */
export interface ProviderInfo {
  name: string | null;
  gateway_host: string | null;
  official: boolean;
}

export interface UsageStream {
  source: string;
  label: string;
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
  limits?: UsageLimit[] | null;
  provider?: ProviderInfo | null;
  cached?: boolean;
  observed_at?: string | null;
  state?: "live" | "cached" | "auth_stale" | "rate_limited" | "offline";
  status_message?: string | null;
}

/** What a collector returns for one cycle. */
export interface Snapshot {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  limits: UsageLimit[] | null;
}

/** Error carrying the classification the scheduler backs off on. */
export interface CodedError extends Error {
  code?: number | string;
  retryMs?: number;
}

export function codedError(message: string, code: number | string, retryMs?: number): CodedError {
  return Object.assign(new Error(message), { code, retryMs });
}
