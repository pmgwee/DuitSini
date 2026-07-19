/**
 * Live price data via Yahoo Finance's public chart endpoint (no API key).
 *
 * Powers the Opportunity Radar's "dip" framing (ask #2): instead of the static
 * "return since tracked" figure, we show the *live* trailing-1-year % change —
 * the same idea Google Finance renders in its red/green box.
 *
 * Why Yahoo: FMP's free tier no longer covers this (v3 endpoints were gated as
 * "legacy" in Aug 2025; the stable endpoints return `[]` for these tickers), and
 * Stooq is behind a JS browser-verification wall. Yahoo's
 * `/v8/finance/chart/{symbol}?range=1y&interval=1d` is keyless and returns
 * `meta.chartPreviousClose` (≈ close one trading year ago) + `meta.regularMarketPrice`,
 * from which the 1Y % is a clean `(price - prevClose) / prevClose`. serenitytrades
 * already tracks Yahoo-compatible symbols (e.g. `SIVE.ST`, `AAOI`).
 *
 * Resilience: any per-symbol failure (network, 429, missing fields) → that ticker
 * is simply omitted and the caller falls back to "since tracked". Cached with a
 * 1-day revalidate (yearly % isn't time-critical) so it's ~one call/symbol/day.
 *
 * Note: Yahoo occasionally rate-limits cloud IPs (e.g. Vercel) with 429 — the
 * graceful fallback means the page still renders, just without live % on some
 * tickers. If you ever need hard reliability, a paid FMP/Alpha Vantage key is the
 * upgrade path.
 */

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const REVALIDATE_SECONDS = 86_400; // 1 day — not time-critical
const UA =
  "Mozilla/5.0 (compatible; subscription-agent-serenity-view/1.0; +price data for personal use)";

interface YahooChartMeta {
  regularMarketPrice?: unknown;
  chartPreviousClose?: unknown;
}
interface YahooChartResult {
  meta?: YahooChartMeta;
  indicators?: {
    adjClose?: Array<{ adjClose?: unknown[] }> | undefined;
    quote?: Array<{ close?: unknown[] }> | undefined;
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Trailing-1-year % change for one symbol, or null on any failure. */
async function fetchOneYearChange(symbol: string, timeoutMs = 8_000): Promise<number | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=1y&interval=1d`, {
      next: { revalidate: REVALIDATE_SECONDS },
      headers: { "user-agent": UA, connection: "close" },
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(t);
    return null;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) return null;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }

  const result = (body as { chart?: { result?: YahooChart[]; error?: unknown } })?.chart?.result?.[0];
  if (!result) return null;

  // Preferred: chartPreviousClose is the close immediately before the 1y window.
  const price = num(result.meta?.regularMarketPrice);
  const prev = num(result.meta?.chartPreviousClose);
  if (price !== null && prev !== null && prev !== 0) {
    return (price - prev) / prev * 100;
  }

  // Fallback: derive from the closes array (first vs last valid).
  const closes =
    (result.indicators?.adjClose?.[0]?.adjClose as unknown[]) ??
    (result.indicators?.quote?.[0]?.close as unknown[]) ??
    [];
  const vals = closes.map(num).filter((v): v is number => v !== null);
  if (vals.length >= 2 && vals[0] !== 0) {
    return (vals[vals.length - 1] - vals[0]) / vals[0] * 100;
  }
  return null;
}

interface YahooChart extends YahooChartResult {}

/**
 * @returns a map of `ticker` → trailing-1-year % change. Tickers that fail are
 *          omitted; callers fall back to "since tracked" for those.
 */
export async function getYearlyChanges(
  entries: { ticker: string; fmpSymbol: string }[],
): Promise<Record<string, number>> {
  const symbols = [...new Set(entries.map((e) => e.fmpSymbol).filter(Boolean))];
  if (symbols.length === 0) return {};

  const results = await Promise.all(
    symbols.map(async (sym) => {
      const y = await fetchOneYearChange(sym);
      return [sym, y] as const;
    }),
  );
  const bySymbol = new Map<string, number | null>();
  for (const [sym, y] of results) bySymbol.set(sym, y);

  const out: Record<string, number> = {};
  for (const e of entries) {
    const y = bySymbol.get(e.fmpSymbol);
    if (y !== null && y !== undefined && Number.isFinite(y)) out[e.ticker] = y;
  }
  return out;
}
