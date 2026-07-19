/**
 * Types for the Serenity Tracker data layer.
 *
 * serenitytrades.com is an independent, *derived* reconstruction of the public
 * posts of the X account @aleabitoreddit ("Serenity"). Everything here is a
 * best-effort parse of that site's public pages — NOT disclosed holdings, and
 * NOT investment advice. See lib/serenity/index.ts for the fetch/cache contract.
 */

export type Region = "US" | "Europe" | "Asia" | "Other";
export type Centrality = "CORE" | "MAJOR" | "PASSING" | "MINOR";
export type Stance = "BULLISH" | "MIXED" | "NEUTRAL" | "BEARISH";
export type LikelyOwned = "YES" | "PROBABLY" | "UNCLEAR" | "NO";

/** A single name in Serenity's tracked universe (from /universe, 180 rows). */
export interface SerenityName {
  ticker: string;
  company: string;
  region: Region;
  likelyOwned: LikelyOwned;
  owned: boolean;
  statedWeightPct: number | null;
  centrality: Centrality;
  conviction: number; // 0–10 (source scale)
  stance: Stance;
  tweetCount: number;
  thesisSummary: string;
}

/** A reconstructed holding with performance (from /performance, ~28 rows). */
export interface SerenityHolding {
  ticker: string;
  company: string;
  fmpSymbol: string;
  region: Region;
  conviction: number; // 0–10
  weightConviction: number; // 0–1 share of the conviction-weighted basket
  weightEqual: number; // 0–1 share of the equal-weighted basket
  returnPct: number; // % return since tracked
}

/** The seven themes serenitytrades.com itself organises the universe into. */
export type SerenityTheme =
  | "Optics / Silicon Photonics"
  | "Memory, Storage & Servers"
  | "Advanced Packaging & Semicap"
  | "Energy, Nuclear & Battery"
  | "Data Center & Cloud"
  | "Drones & Airbus"
  | "Space & Satellites"
  | "Robot / Humanoid"
  | "Fintech & Crypto";

/**
 * The full post topic taxonomy (19 areas) — superset of SerenityTheme. A post can
 * be tagged with several. Used by the LLM/deterministic analyzer + the feed filter.
 */
export type Topic =
  | SerenityTheme
  | "Mega-Cap Tech & Semiconductors"
  | "Networking"
  | "Rare Earth Materials"
  | "Quantum"
  | "SaaS"
  | "Medical / Healthcare"
  | "Cybersecurity"
  | "Meme"
  | "Core / Keystone"
  | "Macro & Market Analysis";

/** A daily commentary post (from /commentary). */
export interface SerenityPost {
  date: string; // YYYY-MM-DD
  headline: string;
  summary: string;
  tickers: string[]; // tagged tickers (e.g. "AAOI"), in order of appearance
  url: string; // /commentary/YYYY-MM-DD on the source site
}

/** A ticker the analyzer pulled from a post, with its contextual stance. */
export interface AnalyzedTicker {
  ticker: string;
  company?: string;
  stance: Stance;
}

/**
 * A Serenity X post enriched by the analyzer: topic tags, a one-line insight, and
 * tickers resolved from BOTH $-cashtags and prose (e.g. "Apptronik"/"Tesla") with
 * per-ticker bullish/bearish stance. `llmAnalyzed=false` means it fell back to the
 * deterministic tagger (no Z.ai key or cache miss) — topics still set, insight empty.
 */
export interface AnalyzedTweet extends SerenityTweet {
  topics: Topic[];
  insight: string;
  analyzedTickers: AnalyzedTicker[];
  llmAnalyzed: boolean;
}

/**
 * A Serenity X post, sourced 1:1 from trackserenity.com's /data/signals.json
 * `tweets[]`. Each carries a direct link to the post on X (the `url`), so the
 * commentary feed can deep-link straight to the original tweet.
 */
export interface SerenityTweet {
  id: string;
  text: string;
  url: string; // direct X link (twitter.com/aleabitoreddit/status/…)
  displayTime: string; // "2026-07-18 12:39" (pre-formatted by the source)
  createdAt: string; // raw X timestamp
  cashtags: string[]; // tickers mentioned (e.g. ["SKHY"])
  isRetweet: boolean;
}

/** A watchlist entry: a ticker recently mentioned by Serenity, by recency. */
export interface WatchlistItem {
  ticker: string;
  lastSeenDisplay: string; // displayTime of the most recent mention
  lastSeenMs: number; // epoch ms of the most recent mention (for sorting)
  mentionCount: number; // how many recent posts mentioned it
  stockUrl: string; // trackserenity.com/stocks/{TICKER}
}

// ───────────────────────── View-models (investor-friendly framing) ─────────────────────────
//
// The source exposes two technical signals per name: `conviction` (0–10, how
// strongly he holds it) and `centrality` (CORE/MAJOR/PASSING/MINOR, how central
// it is in his thesis graph). We reframe both into vocabulary a normal investor
// already knows from broker reports and screeners:
//   - conviction  → Rating   (Strong Buy / Buy / Hold / Watch)
//   - centrality  → Core flag (an accent ring marks his foundational, anchor holdings)

export type Rating = "Strong Buy" | "Buy" | "Hold" | "Watch";

export interface NameView extends SerenityName {
  theme: SerenityTheme;
  rating: Rating; // from conviction — how strongly he recommends it
  core: boolean; // from centrality CORE — a foundational / anchor holding
  usInvestable: boolean;
}

export interface HoldingView extends SerenityHolding {
  rating: Rating;
  contributionConviction: number; // signed share of basket return (weightConviction * returnPct)
  contributionEqual: number;
}

export interface ThemeGroup {
  name: SerenityTheme;
  names: NameView[];
}

/** The full payload the page renders. `stale`/`unavailable` drive the fallback UI. */
export interface SerenityData {
  holdings: HoldingView[];
  universe: NameView[];
  themes: ThemeGroup[];
  feed: AnalyzedTweet[]; // trackserenity X posts, enriched by the analyzer
  watchlist: WatchlistItem[]; // trackserenity recently-mentioned tickers
  prices: Record<string, number>; // ticker → trailing 1-year % (FMP); {} when no key/failure
  feedUpdatedAt: string | null; // trackserenity's own last-sync timestamp (ISO) — proves the X feed is live
  fetchedAt: number; // epoch ms of the last successful fresh fetch
  sourceUrl: string; // serenitytrades.com (holdings/universe/themes)
  trackSerenityUrl: string; // trackserenity.com (feed/watchlist)
  stale: boolean; // true when we're serving cached data after a fetch failure
  unavailable: boolean; // true when there is no data at all (initial fetch failed)
}

export const SERENITYTRADES_URL = "https://serenitytrades.com";
export const TRACKSERENITY_URL = "https://www.trackserenity.com";

export const SERENITY_THEMES: SerenityTheme[] = [
  "Optics / Silicon Photonics",
  "Memory, Storage & Servers",
  "Advanced Packaging & Semicap",
  "Energy, Nuclear & Battery",
  "Data Center & Cloud",
  "Drones & Airbus",
  "Space & Satellites",
  "Robot / Humanoid",
  "Fintech & Crypto",
];
