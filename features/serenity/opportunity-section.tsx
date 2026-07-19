"use client";

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Flame, ListChecks, Star, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HoldingView, NameView, Rating, WatchlistItem } from "@/lib/serenity/types";
import { formatPct, RATING_STYLE, SOURCE_BASE, StanceDot } from "./shared";

/** A compact opportunity chip — ticker + rating glyph + optional return + Core ring. */
function OppChip({
  ticker,
  rating,
  core,
  returnPct,
  title,
}: {
  ticker: string;
  rating: Rating;
  core: boolean;
  returnPct?: number;
  title: string;
}) {
  const s = RATING_STYLE[rating];
  return (
    <a
      href={`${SOURCE_BASE}/universe/${ticker.toLowerCase()}`}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg bg-surface/80 px-2 py-1 leading-none ring-1 ring-border/60 transition-all hover:-translate-y-0.5 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        s.chip,
        core && "ring-2 ring-primary/60",
      )}
    >
      <span className="font-semibold tracking-tight">{ticker}</span>
      {s.glyph ? <span aria-hidden>{s.glyph}</span> : null}
      {typeof returnPct === "number" ? (
        <span className="text-[10px] font-medium tabular-nums" style={{ color: returnPct >= 0 ? "var(--success)" : "var(--danger)" }}>
          {formatPct(returnPct)}
        </span>
      ) : null}
    </a>
  );
}

function OppCard({
  icon,
  tint,
  title,
  blurb,
  empty,
  children,
}: {
  icon: React.ReactNode;
  tint: string;
  title: string;
  blurb: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-border/60 bg-surface/40 p-4">
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-lg" style={{ background: `color-mix(in oklch, ${tint} 16%, transparent)`, color: tint }}>
          {icon}
        </span>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      </div>
      <p className="text-[11px] text-muted-foreground">{blurb}</p>
      <div className="flex flex-wrap content-start gap-1.5">
        {children ?? <span className="text-xs text-muted-foreground/70">{empty}</span>}
      </div>
    </div>
  );
}

export function OpportunitySection({
  holdings,
  universe,
  watchlist,
  prices,
}: {
  holdings: HoldingView[];
  universe: NameView[];
  watchlist: WatchlistItem[];
  prices: Record<string, number>;
}) {
  const reduce = useReducedMotion();
  const [usOnly, setUsOnly] = useState(true);

  const viewByTicker = useMemo(() => {
    const m = new Map<string, NameView>();
    for (const n of universe) m.set(n.ticker, n);
    return m;
  }, [universe]);

  // A watchlist ticker is "US-investable" if the universe says so, else a rough
  // heuristic (pure-letter ticker ≤6 chars) that flags digit-led foreign listings
  // (Korean 010690, Chinese 300376, …) as non-US.
  const looksUs = (t: string) => /^[A-Z]{1,6}$/.test(t);
  const isUsWatch = (ticker: string) => {
    const v = viewByTicker.get(ticker);
    return v ? v.usInvestable : looksUs(ticker);
  };
  const shownWatch = watchlist.filter((w) => (usOnly ? isUsWatch(w.ticker) : true));
  const [watchExpanded, setWatchExpanded] = useState(false);
  const visibleWatch = watchExpanded ? shownWatch : shownWatch.slice(0, 18);

  const { dipBuys, trending, strongBuys } = useMemo(() => {
    // Dip alerts: the bullish US names that are underwater in his book (down since
    // he tracked them) — each shown with its LIVE trailing-1-year % when available
    // (falls back to "since tracked"). The set is fixed by the since-tracked figure
    // so the dip list never shrinks just because a name has recovered over the past
    // year; the live % is the display, not the filter.
    const dipBuys = holdings
      .map((h) => ({ h, v: viewByTicker.get(h.ticker) }))
      .filter((x): x is { h: HoldingView; v: NameView } => Boolean(x.v))
      .filter(({ v }) => v.stance === "BULLISH" && v.usInvestable)
      .filter(({ h }) => h.returnPct < 0)
      .map(({ h, v }) => {
        const live = prices[h.ticker];
        const shown = typeof live === "number" ? live : h.returnPct;
        return { h, v, shown, live: typeof live === "number" };
      })
      .sort((a, b) => a.shown - b.shown)
      .slice(0, 12);

    const trending = universe
      .filter((n) => n.stance === "BULLISH" && n.usInvestable)
      .sort((a, b) => b.tweetCount - a.tweetCount)
      .slice(0, 9);

    const strongBuys = universe
      .filter((n) => n.rating === "Strong Buy" && n.stance === "BULLISH" && n.usInvestable)
      .sort((a, b) => b.conviction - a.conviction || b.tweetCount - a.tweetCount)
      .slice(0, 9);

    return { dipBuys, trending, strongBuys };
  }, [holdings, universe, viewByTicker, prices]);

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 16 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      aria-label="Dip and opportunity radar"
      className="overflow-hidden rounded-3xl border border-danger/30"
    >
      {/* Marketing banner */}
      <div className="relative isolate bg-gradient-to-br from-danger/25 via-background to-success/15 px-5 py-6 sm:px-7 sm:py-8">
        <div className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full bg-danger/20 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -bottom-24 left-6 size-56 rounded-full bg-success/15 blur-3xl" aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-danger">
              <TrendingDown className="size-3" />
              Opportunity Radar
            </div>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-balance sm:text-[28px]">Be greedy when others are fearful.</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              The market just shook out his bullish names — these are the ones trading below where he tracks them. His
              conviction hasn&apos;t moved; the price just did. Your dip-buy shortlist, live.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-surface/50 px-3 py-1.5 text-[11px] text-muted-foreground">
            <TrendingUp className="size-3.5 text-success" />
            refreshed every few min
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-border/60 bg-surface/20 p-5 sm:p-6">
        {/* Serenity Watchlist — full width, scrollable, US-toggle */}
        <div className="rounded-2xl border border-border/60 bg-surface/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary">
                <ListChecks className="size-4" />
              </span>
              <h3 className="text-sm font-semibold tracking-tight">Serenity Watchlist</h3>
              <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {shownWatch.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden text-[11px] text-muted-foreground sm:inline">Recently mentioned · tap a ticker for his thesis</span>
              <button
                type="button"
                onClick={() => setUsOnly((v) => !v)}
                aria-pressed={usOnly}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors",
                  usOnly
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border/60 bg-surface/40 text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={cn("relative inline-block size-3 rounded-full border", usOnly ? "border-primary" : "border-border")}>
                  <span className={cn("absolute inset-0.5 rounded-full", usOnly ? "bg-primary" : "bg-transparent")} />
                </span>
                {usOnly ? "US-investable" : "All tickers"}
              </button>
            </div>
          </div>
          {shownWatch.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground/70">
              {usOnly ? "No US-investable tickers in the recent feed — toggle to “All tickers”." : "Watchlist is syncing — check back shortly."}
            </p>
          ) : (
            <div className="mt-3">
              <div className="flex flex-wrap gap-1.5">
                {visibleWatch.map((w) => {
                  const v = viewByTicker.get(w.ticker);
                  const s = v ? RATING_STYLE[v.rating] : null;
                  return (
                    <a
                      key={w.ticker}
                      href={w.stockUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`${w.ticker}${v?.company ? " — " + v.company : ""} · mentioned ${w.mentionCount}× · last ${w.lastSeenDisplay}`}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg bg-surface/80 px-2 py-1 leading-none ring-1 ring-border/60 transition-all hover:-translate-y-0.5 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
                        v?.core && "ring-2 ring-primary/60",
                        v ? s!.chip : "text-xs font-medium text-muted-foreground",
                      )}
                    >
                      {v ? <StanceDot stance={v.stance} /> : null}
                      <span className="font-semibold tracking-tight">{w.ticker}</span>
                      {s?.glyph ? <span aria-hidden>{s.glyph}</span> : null}
                      <span className="text-[9px] tabular-nums text-muted-foreground">×{w.mentionCount}</span>
                    </a>
                  );
                })}
              </div>
              {shownWatch.length > 18 ? (
                <button
                  type="button"
                  onClick={() => setWatchExpanded((v) => !v)}
                  className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                >
                  {watchExpanded ? "Show less ↑" : `Show all ${shownWatch.length} ↓`}
                </button>
              ) : null}
            </div>
          )}
        </div>

        {/* Three opportunity lists */}
        <div className="grid gap-4 sm:grid-cols-3">
          <OppCard
            icon={<TrendingDown className="size-4" />}
            tint="var(--danger)"
            title="🩸 Dip alerts"
            blurb="Bullish names underwater in his book — with their live 1-year move."
            empty="No bullish names are down right now."
          >
            {dipBuys.map(({ h, v, shown, live }) => (
              <OppChip
                key={h.ticker}
                ticker={h.ticker}
                rating={v.rating}
                core={v.core}
                returnPct={shown}
                title={`${h.company || h.ticker} — ${v.rating}${v.core ? " · Core" : ""} · ${formatPct(shown)} ${live ? "(past year)" : "(since tracked)"}`}
              />
            ))}
          </OppCard>

          <OppCard
            icon={<Flame className="size-4" />}
            tint="var(--warning)"
            title="🔥 Trending now"
            blurb="The bullish names he's been talking up most."
            empty="No bullish names trending."
          >
            {trending.map((n) => (
              <OppChip
                key={n.ticker}
                ticker={n.ticker}
                rating={n.rating}
                core={n.core}
                title={`${n.company || n.ticker} — ${n.rating}${n.core ? " · Core" : ""} · ${n.tweetCount} mentions`}
              />
            ))}
          </OppCard>

          <OppCard
            icon={<Star className="size-4" />}
            tint="var(--primary)"
            title="⭐ Strong Buys"
            blurb="His highest-conviction calls right now."
            empty="No Strong Buy names."
          >
            {strongBuys.map((n) => (
              <OppChip
                key={n.ticker}
                ticker={n.ticker}
                rating={n.rating}
                core={n.core}
                title={`${n.company || n.ticker} — ${n.rating}${n.core ? " · Core" : ""}`}
              />
            ))}
          </OppCard>
        </div>
      </div>
    </motion.section>
  );
}
