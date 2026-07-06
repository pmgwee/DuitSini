"use client";

import { useEffect, useState } from "react";

export interface LiveUsageWindow {
  utilization: number | null;
  /** ISO timestamp the window resets at. */
  resets_at: string | null;
}

export interface LiveUsage {
  five_hour?: LiveUsageWindow | null;
  seven_day?: LiveUsageWindow | null;
  error?: string;
  message?: string;
  cached?: boolean;
  refreshed_at?: string;
}

export type LiveStatus = "connecting" | "live" | "error";

/** Where the local Claude Usage Bridge is expected to run. */
export const CLAUDE_USAGE_BRIDGE_URL =
  process.env.NEXT_PUBLIC_CLAUDE_USAGE_BRIDGE_URL ?? "http://127.0.0.1:4785";

/**
 * Polls the local Claude Usage Bridge for real plan usage. Returns
 * `connecting` until the first response, then `live` (with data) or `error`
 * (bridge not running / upstream failed). Personal/local use only.
 */
export function useClaudeUsageLive(intervalMs = 240_000): {
  status: LiveStatus;
  data?: LiveUsage;
  error?: string;
} {
  const [state, setState] = useState<{
    status: LiveStatus;
    data?: LiveUsage;
    error?: string;
  }>({ status: "connecting" });

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const r = await fetch(`${CLAUDE_USAGE_BRIDGE_URL}/usage`, {
          headers: { Accept: "application/json" },
        });
        if (!r.ok) throw new Error(String(r.status));
        const d: LiveUsage = await r.json();
        if (!active) return;
        if (d.error) {
          setState({ status: "error", data: d, error: d.message ?? d.error });
        } else {
          setState({ status: "live", data: d });
        }
      } catch {
        if (active) {
          // Don't clobber a good 'live' state with a transient fetch failure.
          setState((prev) => (prev.status === "live" ? prev : { status: "error" }));
        }
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}
