import { TRACKSERENITY_URL } from "./types";
import type { SerenityTweet, WatchlistItem } from "./types";

/**
 * trackserenity.com data layer.
 *
 * The whole site is driven by one public JSON file — `/data/signals.json` — which
 * is a near-real-time mirror of Serenity's X posts (`tweets[]`, each with a
 * direct X link) plus live quotes. We use it for:
 *   - the commentary feed (ask #1): real X posts, each linking to the tweet on X
 *   - the watchlist (ask #3): "Recently mentioned by Serenity" = distinct tickers
 *     from those posts, ordered by most-recent mention, deep-linking to the
 *     site's per-stock thesis page `/stocks/{TICKER}`.
 *
 * robots.txt is `Allow: /`, and the file is fetched with Next revalidate (5 min)
 * so it stays current without hammering the origin. Parse failures degrade to
 * empty arrays — the rest of the page (serenitytrades holdings/universe) still
 * renders.
 */

const SIGNALS_REVALIDATE_SECONDS = 300; // 5 min — it's a live X feed
const UA =
  "duitsini-serenity-view/1.0 (+derived view of trackserenity.com; respectful, cached, attributed)";

export interface TrackSerenitySignals {
  tweets: SerenityTweet[];
  watchlist: WatchlistItem[];
  updatedAt: string | null;
}

interface RawTweet {
  id?: string;
  text?: string;
  url?: string;
  createdAt?: string;
  displayTime?: string;
  cashtags?: string[];
  isRetweet?: boolean;
}

function toMs(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const t = Date.parse(timestamp);
  return Number.isFinite(t) ? t : 0;
}

/** Derive the watchlist (recently-mentioned tickers) from the feed. */
function deriveWatchlist(tweets: SerenityTweet[], limit = 60): WatchlistItem[] {
  const byTicker = new Map<string, WatchlistItem>();
  for (const tw of tweets) {
    if (tw.isRetweet) continue;
    const ms = toMs(tw.createdAt);
    for (const raw of tw.cashtags) {
      const ticker = raw.toUpperCase().replace(/[^A-Z0-9.]/g, "");
      if (!ticker) continue;
      const existing = byTicker.get(ticker);
      if (existing) {
        existing.mentionCount += 1;
        if (ms > existing.lastSeenMs) {
          existing.lastSeenMs = ms;
          existing.lastSeenDisplay = tw.displayTime;
        }
      } else {
        byTicker.set(ticker, {
          ticker,
          lastSeenDisplay: tw.displayTime,
          lastSeenMs: ms,
          mentionCount: 1,
          stockUrl: `${TRACKSERENITY_URL}/stocks/${ticker}`,
        });
      }
    }
  }
  return [...byTicker.values()].sort((a, b) => b.lastSeenMs - a.lastSeenMs).slice(0, limit);
}

export async function fetchTrackSerenitySignals(): Promise<TrackSerenitySignals> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${TRACKSERENITY_URL}/data/signals.json`, {
      // Tagged so the /api/cron/serenity warmer can proactively purge + refresh
      // this feed on a schedule (independent of visitor traffic).
      next: { revalidate: SIGNALS_REVALIDATE_SECONDS, tags: ["serenity-feed"] },
      headers: { "user-agent": UA, connection: "close" },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`trackserenity signals.json → HTTP ${res.status}`);

  const data = (await res.json()) as { tweets?: RawTweet[]; updatedAt?: string };

  const tweets: SerenityTweet[] = (data.tweets ?? [])
    .filter((tw) => tw && typeof tw.text === "string" && typeof tw.url === "string")
    .map<SerenityTweet>((tw) => ({
      id: tw.id ?? tw.url ?? "",
      text: tw.text as string,
      url: tw.url as string,
      displayTime: tw.displayTime ?? tw.createdAt ?? "",
      createdAt: tw.createdAt ?? "",
      cashtags: Array.isArray(tw.cashtags) ? tw.cashtags.map((c) => String(c)) : [],
      isRetweet: Boolean(tw.isRetweet),
    }));

  return {
    tweets,
    watchlist: deriveWatchlist(tweets),
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
  };
}
