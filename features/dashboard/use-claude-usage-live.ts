"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export interface LiveUsageWindow {
  utilization: number | null;
  /** ISO timestamp the window resets at. */
  resets_at: string | null;
}

/** A single usage limit row, mirroring claude.ai's panel (session + weekly). */
export interface UsageLimit {
  key: string;
  label: string;
  group: "session" | "weekly";
  percent: number | null;
  resets_at: string | null;
  severity?: string | null;
}

/** Which cc-switch provider was active on the bridge machine for this snapshot. */
export interface UsageProvider {
  name: string | null;
  gateway_host: string | null;
  official: boolean;
}

export interface LiveUsage {
  five_hour?: LiveUsageWindow | null;
  seven_day?: LiveUsageWindow | null;
  limits?: UsageLimit[] | null;
  provider?: UsageProvider | null;
  error?: string;
  message?: string;
  cached?: boolean;
  refreshed_at?: string;
}

export type LiveStatus = "connecting" | "live" | "error";

/**
 * Same-origin endpoint that serves the latest snapshot the local Claude Usage
 * Bridge pushed to the server.
 */
export const CLAUDE_USAGE_LIVE_URL = "/api/claude-usage/live";

/**
 * Live plan usage with three delivery paths, most-to-least immediate:
 *   1. Supabase Realtime — the moment the bridge writes a new snapshot, the
 *      browser re-reads it (no page refresh, no poll wait).
 *   2. `pull()` — asks the bridge to fetch fresh from Anthropic now, then
 *      rapidly re-polls to catch the result even if realtime is unavailable.
 *   3. A slow interval poll as a safety net.
 */
export function useClaudeUsageLive(intervalMs = 15_000): {
  status: LiveStatus;
  data?: LiveUsage;
  error?: string;
  refresh: () => void;
  refreshing: boolean;
  pull: () => void;
  pulling: boolean;
} {
  const [state, setState] = useState<{
    status: LiveStatus;
    data?: LiveUsage;
    error?: string;
  }>({ status: "connecting" });
  const [refreshing, setRefreshing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const tickRef = useRef<() => Promise<void>>(async () => {});
  const dataRef = useRef<LiveUsage | undefined>(undefined);
  const pullBaselineRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    dataRef.current = state.data;
  }, [state.data]);

  // Stop the "Pulling…" spinner as soon as a fresher snapshot lands.
  useEffect(() => {
    if (
      pulling &&
      state.data?.refreshed_at &&
      state.data.refreshed_at !== pullBaselineRef.current
    ) {
      setPulling(false);
    }
  }, [state.data?.refreshed_at, pulling]);

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
        if (d.error) setState({ status: "error", data: d, error: d.message ?? d.error });
        else setState({ status: "live", data: d });
      } catch {
        // Don't clobber a good 'live' state with a transient fetch failure.
        if (active) setState((prev) => (prev.status === "live" ? prev : { status: "error" }));
      }
    };
    tickRef.current = tick;
    tick();
    const id = setInterval(tick, intervalMs);

    // Realtime: a bridge push updates the row → re-read immediately.
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel("claude_usage_live_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "claude_usage_live" },
        () => {
          void tickRef.current();
        },
      )
      .subscribe();

    return () => {
      active = false;
      clearInterval(id);
      void supabase.removeChannel(channel);
    };
  }, [intervalMs]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void tickRef.current().finally(() => setRefreshing(false));
  }, []);

  const pull = useCallback(() => {
    setPulling(true);
    pullBaselineRef.current = dataRef.current?.refreshed_at;
    void fetch("/api/claude-usage/pull", { method: "POST" }).catch(() => {
      /* the burst re-poll below still catches any push */
    });
    // Rapidly re-check for the bridge's fresh push, independent of realtime.
    let n = 0;
    const burst = window.setInterval(() => {
      n += 1;
      void tickRef.current();
      if (n >= 8) window.clearInterval(burst);
    }, 1800);
    window.setTimeout(() => setPulling(false), 16_000);
  }, []);

  return { ...state, refresh, refreshing, pull, pulling };
}
