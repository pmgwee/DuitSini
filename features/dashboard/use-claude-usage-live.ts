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

/**
 * Same-origin endpoint that serves the latest snapshot the local Claude Usage
 * Bridge pushed to the server. The browser never talks to localhost directly —
 * that avoids mixed-content / Private Network Access blocking on the deployed
 * HTTPS site and lets the live number show up on any device.
 */
export const CLAUDE_USAGE_LIVE_URL = "/api/claude-usage/live";

/**
 * Polls the app's live-usage endpoint. Returns `connecting` until the first
 * response, then `live` (with fresh data) or `error` (no snapshot yet / stale /
 * not signed in) which drives the manual fallback. Personal use only.
 */
export function useClaudeUsageLive(intervalMs = 30_000): {
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
        const r = await fetch(CLAUDE_USAGE_LIVE_URL, {
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
