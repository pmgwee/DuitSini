"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SerenityData } from "@/lib/serenity/types";
import { HoldingsRing } from "./holdings-ring";
import { ThemeConstellation } from "./theme-constellation";
import { PostsFeed } from "./posts-feed";
import { OpportunitySection } from "./opportunity-section";
import { RobotVision } from "./robot-vision";
import { ATTRIBUTION, SOURCE_BASE, TRACKSERENITY_BASE } from "./shared";

const POLL_MS = 3 * 60_000; // live feel: re-pull every 3 min while the tab is visible

/**
 * NOTE on `feedUpdatedAt` semantics — do not turn this into a staleness alarm.
 *
 * trackserenity's `updatedAt` tracks when the feed CONTENT last changed, not when
 * their scraper last ran: observed 2026-07-19, it sat 4 minutes after the newest
 * tweet while both were 28h old. So an old stamp means "Serenity hasn't posted
 * lately" — which over a weekend or an overnight is completely normal — NOT that
 * the pipeline is broken. An earlier revision warned "X feed lagging" past 60 min
 * and would have fired every weekend, telling the audience their data was suspect
 * when it was perfectly current. We now state the age as a neutral fact and reserve
 * the amber state for a genuine fetch failure (no stamp / empty feed).
 */

function relativeFrom(ms: number | undefined, now: number): string {
  if (!ms) return "just now";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** trackserenity's ISO sync stamp → epoch ms (null when absent/unparseable). */
function parseFeedStamp(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function UnavailableBanner() {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-4">
      <div className="flex items-center gap-2.5 text-sm font-medium">
        <ShieldAlert className="size-4 shrink-0 text-danger" />
        Tracker data is temporarily unavailable
      </div>
      <p className="text-xs text-muted-foreground">
        The source couldn&apos;t be reached just now. This is usually transient — it refreshes automatically, or read the
        reconstruction directly on the source site.
      </p>
      <a
        href={SOURCE_BASE}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs font-medium hover:text-foreground"
      >
        Open serenitytrades.com
      </a>
    </div>
  );
}

function Attribution() {
  return (
    <footer className="flex flex-col gap-1 rounded-2xl border border-border/40 bg-surface/20 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground/80">
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 size-3 shrink-0 text-muted-foreground/60" />
        <p>
          {ATTRIBUTION}{" "}
          <a href={SOURCE_BASE} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
            serenitytrades.com
          </a>{" "}
          ·{" "}
          <a href={TRACKSERENITY_BASE} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
            trackserenity.com
          </a>
          .
        </p>
      </div>
      <p className="pl-4">
        Holdings, conviction and theme tags are an estimate from public posts — not disclosed positions. Do your own research.
      </p>
    </footer>
  );
}

export function SerenityView({ initialData }: { initialData: SerenityData }) {
  // react-query polls /api/serenity every POLL_MS (paused when the tab is hidden).
  // Seeded with the server-rendered snapshot so the first paint is instant and
  // there's no flash; dataUpdatedAt drives the "updated X ago" stamp.
  const query = useQuery({
    queryKey: ["serenity"],
    queryFn: async () => {
      const r = await fetch("/api/serenity", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as SerenityData;
    },
    initialData,
    initialDataUpdatedAt: initialData.fetchedAt,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });

  // Seeded from the server snapshot (NOT Date.now()) so the first client paint
  // matches SSR exactly — relative stamps are derived from `fetchedAt` on both
  // sides. Corrected to wall-clock immediately after hydration, then every 30s.
  const [now, setNow] = useState(() => initialData.fetchedAt || 0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const data = query.data ?? initialData;

  // Freshness is judged on the X feed itself, not on when the browser last polled.
  // getSerenityData() swallows a trackserenity failure (`.catch(() => null)`) and
  // still returns stale=false, so without this an outage renders a green "Live"
  // badge over an empty feed — the exact thing the audience must never be shown.
  // Only a genuine fetch failure is amber. Post age is reported, never judged.
  const feedMs = parseFeedStamp(data.feedUpdatedAt);
  const feedDown = feedMs === null || data.feed.length === 0;
  const live = !data.unavailable && !data.stale && !feedDown;

  const status = data.unavailable
    ? { dot: "bg-danger", label: "Unavailable" }
    : data.stale
      ? { dot: "bg-warning", label: "Cached snapshot" }
      : feedDown
        ? { dot: "bg-warning", label: "X feed unavailable" }
        : { dot: "bg-success", label: "Live" };

  return (
    <div className="flex flex-col gap-6">
      {/* Freshness bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="inline-flex flex-wrap items-center gap-1.5 text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", status.dot, live && "animate-pulse")} />
          <span className="font-medium text-foreground">{status.label}</span>
          <span className="text-muted-foreground/50">·</span>
          {/* "latest post", not "synced" — this stamp tracks when Serenity last
              posted, so calling it a sync time reads as a pipeline fault during
              any normal quiet spell (nights, weekends, market holidays). */}
          <span>
            {feedMs === null ? "X feed unavailable" : `latest post ${relativeFrom(feedMs, now)}`}
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground/70">checked {relativeFrom(query.dataUpdatedAt, now)}</span>
        </div>
        <button
          type="button"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 font-medium transition-colors hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3.5", query.isFetching && "animate-spin")} />
          {query.isFetching ? "Refreshing" : "Refresh"}
        </button>
      </div>

      {query.isError ? (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-muted-foreground">
          Couldn&apos;t refresh just now — showing the last good snapshot.
        </div>
      ) : null}

      {/* The portfolio/theme sections come from serenitytrades and can render fine
          while the X feed is down. Say so explicitly rather than showing an empty
          feed that reads as "Serenity hasn't posted". */}
      {!data.unavailable && feedDown ? (
        <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-muted-foreground">
          Serenity&apos;s X posts couldn&apos;t be loaded from trackserenity.com right now — holdings and themes below are
          still current, but the post feed may be incomplete. Auto-retries every {Math.round(POLL_MS / 60_000)} min.
        </div>
      ) : null}

      {data.unavailable ? (
        <UnavailableBanner />
      ) : (
        <>
          <OpportunitySection
            holdings={data.holdings}
            universe={data.universe}
            watchlist={data.watchlist}
            prices={data.prices}
          />
          <HoldingsRing holdings={data.holdings} />
          <ThemeConstellation themes={data.themes} />
          <RobotVision universe={data.universe} />
          <PostsFeed feed={data.feed} />
        </>
      )}

      <Attribution />
    </div>
  );
}
