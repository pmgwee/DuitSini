import { fetchSerenityRSC, SERENITY_SOURCE_URL } from "./client";
import { extractObjects } from "./parse";
import { holdingSchema, nameSchema } from "./schema";
import { classifyTheme, isCoreHolding, isUsInvestable, rating } from "./metrics";
import { fetchTrackSerenitySignals } from "./trackserenity";
import { getYearlyChanges } from "./prices";
import {
  SERENITY_THEMES,
  TRACKSERENITY_URL,
  type Centrality,
  type HoldingView,
  type LikelyOwned,
  type NameView,
  type Region,
  type SerenityData,
  type SerenityHolding,
  type SerenityName,
  type Stance,
  type ThemeGroup,
} from "./types";

/**
 * The Serenity Tracker data layer entry point.
 *
 * `getSerenityData()` is all the page should call. It serves the cache when
 * fresh, otherwise fetches the three source pages in parallel, parses + remaps
 * them into view-models, caches the result, and returns it. On any failure it
 * returns the stale cache if one exists, else a structured `unavailable` payload
 * the UI renders as a graceful panel — it never throws to the page.
 *
 * Everything here is DERIVED from serenitytrades.com (itself a reconstruction of
 * @aleabitoreddit's public posts). Not affiliated. Not investment advice.
 */

const EMPTY_THEMES: ThemeGroup[] = SERENITY_THEMES.map((name) => ({ name, names: [] }));

function asRegion(s: string): Region {
  return (s === "US" || s === "Europe" || s === "Asia" || s === "Other" ? s : "Other") as Region;
}
function asCentrality(s: string): Centrality {
  return (s === "CORE" || s === "MAJOR" || s === "PASSING" || s === "MINOR" ? s : "MINOR") as Centrality;
}
function asStance(s: string): Stance {
  return (s === "BULLISH" || s === "MIXED" || s === "NEUTRAL" || s === "BEARISH" ? s : "NEUTRAL") as Stance;
}
function asLikelyOwned(s: string): LikelyOwned {
  return (s === "YES" || s === "PROBABLY" || s === "UNCLEAR" || s === "NO" ? s : "NO") as LikelyOwned;
}

function toName(raw: {
  ticker: string;
  company: string;
  region: string;
  likely_owned: string;
  owned: boolean;
  stated_weight_pct: number | null;
  centrality: string;
  conviction: number;
  stance: string;
  tweet_count: number;
  thesis_summary: string;
}): SerenityName {
  return {
    ticker: raw.ticker,
    company: raw.company,
    region: asRegion(raw.region),
    likelyOwned: asLikelyOwned(raw.likely_owned),
    owned: raw.owned,
    statedWeightPct: raw.stated_weight_pct,
    centrality: asCentrality(raw.centrality),
    conviction: raw.conviction,
    stance: asStance(raw.stance),
    tweetCount: raw.tweet_count,
    thesisSummary: raw.thesis_summary,
  };
}

function toNameView(name: SerenityName): NameView {
  return {
    ...name,
    theme: classifyTheme(name),
    rating: rating(name.conviction),
    core: isCoreHolding(name.centrality),
    usInvestable: isUsInvestable(name),
  };
}

function toHoldingView(h: SerenityHolding): HoldingView {
  return {
    ...h,
    rating: rating(h.conviction),
    contributionConviction: h.weightConviction * h.returnPct,
    contributionEqual: h.weightEqual * h.returnPct,
  };
}

function groupByTheme(names: NameView[]): ThemeGroup[] {
  const byTheme = new Map<SerenityData["themes"][number]["name"], NameView[]>();
  for (const n of names) {
    const arr = byTheme.get(n.theme) ?? [];
    arr.push(n);
    byTheme.set(n.theme, arr);
  }
  return SERENITY_THEMES.map((name) => ({
    name,
    names: (byTheme.get(name) ?? []).sort((a, b) => b.conviction - a.conviction),
  }));
}

/** serenitytrades.com only: holdings + universe + themes (the portfolio view). */
async function fetchSerenityBase(): Promise<{ holdings: HoldingView[]; universe: NameView[]; themes: ThemeGroup[] }> {
  const [uniRsc, perfRsc] = await Promise.all([fetchSerenityRSC("/universe"), fetchSerenityRSC("/performance")]);

  // Universe names — validate + dedupe by ticker.
  const names: SerenityName[] = [];
  const seenName = new Set<string>();
  for (const obj of extractObjects(uniRsc, /"ticker":/)) {
    const p = nameSchema.safeParse(obj);
    if (!p.success) continue;
    if (seenName.has(p.data.ticker)) continue;
    seenName.add(p.data.ticker);
    names.push(toName(p.data));
  }

  // Holdings — validate (drops the "no FMP data" row), dedupe.
  const holdings: SerenityHolding[] = [];
  const seenHold = new Set<string>();
  for (const obj of extractObjects(perfRsc, /"ticker":/)) {
    const p = holdingSchema.safeParse(obj);
    if (!p.success) continue;
    if (seenHold.has(p.data.ticker)) continue;
    seenHold.add(p.data.ticker);
    holdings.push({
      ticker: p.data.ticker,
      company: p.data.company,
      fmpSymbol: p.data.fmp_symbol,
      region: asRegion(p.data.region),
      conviction: p.data.conviction,
      weightConviction: p.data.weight_conviction,
      weightEqual: p.data.weight_equal,
      returnPct: p.data.return_pct,
    });
  }

  const universe = names.map(toNameView);
  const themes = groupByTheme(universe);

  return {
    holdings: holdings
      .map(toHoldingView)
      .sort((a, b) => Math.abs(b.contributionConviction) - Math.abs(a.contributionConviction)),
    universe,
    themes,
  };
}

/**
 * Aggregate all three sources into one payload. serenitytrades is required (the
 * portfolio view); trackserenity (X feed + watchlist) and FMP (live 1Y prices)
 * each degrade independently to empty on failure, so a hiccup in one never takes
 * down the page.
 */
async function fetchFresh(): Promise<SerenityData> {
  const [base, signals] = await Promise.all([
    fetchSerenityBase(),
    fetchTrackSerenitySignals().catch(() => null),
  ]);

  // Live trailing-1-year % for holdings' dip framing (no-key/failure → {} → falls
  // back to "since tracked" in the UI).
  const prices = await getYearlyChanges(
    base.holdings.map((h) => ({ ticker: h.ticker, fmpSymbol: h.fmpSymbol })),
  ).catch(() => ({}));

  return {
    holdings: base.holdings,
    universe: base.universe,
    themes: base.themes,
    feed: signals?.tweets ?? [],
    watchlist: signals?.watchlist ?? [],
    prices: prices ?? {},
    feedUpdatedAt: signals?.updatedAt ?? null,
    fetchedAt: Date.now(),
    sourceUrl: SERENITY_SOURCE_URL,
    trackSerenityUrl: TRACKSERENITY_URL,
    stale: false,
    unavailable: false,
  };
}

/**
 * Last successfully parsed snapshot — kept purely as a resilience fallback for
 * the rare case where the upstream fetch succeeds but parsing yields nothing
 * (e.g. a site refactor shifts the RSC shape). Freshness is handled by the
 * platform Data Cache (client.ts `revalidate`), NOT by this variable — there is
 * no TTL here, just "serve the last good parse if a new one blows up."
 */
let lastGood: SerenityData | null = null;

export async function getSerenityData(): Promise<SerenityData> {
  try {
    const data = await fetchFresh();
    lastGood = data;
    return data;
  } catch (err) {
    console.error("[serenity] fetch failed:", (err as Error)?.message ?? err);
    if (lastGood) return { ...lastGood, stale: true };
    return {
      holdings: [],
      universe: [],
      themes: EMPTY_THEMES,
      feed: [],
      watchlist: [],
      prices: {},
      feedUpdatedAt: null,
      fetchedAt: 0,
      sourceUrl: SERENITY_SOURCE_URL,
      trackSerenityUrl: TRACKSERENITY_URL,
      stale: false,
      unavailable: true,
    };
  }
}
