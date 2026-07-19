/**
 * HTTP client for serenitytrades.com's public pages.
 *
 * Two transports, because the site renders different pages differently:
 *  - `/universe` and `/performance` are client-rendered, but their data ships as
 *    flat JSON inside the React Server Component payload. `fetchSerenityRSC`
 *    requests that payload directly with the `RSC: 1` header → clean JSON, no
 *    headless browser needed.
 *  - `/commentary` is server-rendered HTML, so `fetchSerenityHTML` grabs the
 *    normal page (headline + summary + ticker chips are right there in the SSR).
 *
 * Caching: every fetch uses Next's time-based revalidation (`next.revalidate`),
 * backed on Vercel by the platform's shared, cross-instance Data Cache with
 * stale-while-revalidate semantics. So all users/instances read ONE snapshot,
 * upstream is deduped platform-wide (≤ one fetch per window), a new session after
 * the window is served instantly and revalidated in the background, and a failed
 * revalidation keeps serving the last good response. This replaces a per-instance
 * in-memory cache, which couldn't share across instances or survive cold starts.
 *
 * Every fetch still hard-aborts after `timeoutMs` (a stalled origin can never
 * hang the request) and sends `connection: close` (no stale keep-alive sockets).
 */

const BASE = "https://serenitytrades.com";
const UA =
  "subscription-agent-serenity-view/1.0 (+derived view of serenitytrades.com; respectful, cached, attributed)";

/** How often the platform revalidates the upstream snapshot (seconds). */
export const SERENITY_REVALIDATE_SECONDS = 900; // 15 min

async function timedFetch(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      next: { revalidate: SERENITY_REVALIDATE_SECONDS },
      headers: { "user-agent": UA, connection: "close", ...headers },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export function fetchSerenityRSC(path: string, timeoutMs = 10_000): Promise<string> {
  return timedFetch(`${BASE}${path}`, { RSC: "1", "Next-Router-State-Tree": "%5B%22%22%5D" }, timeoutMs);
}

export function fetchSerenityHTML(path: string, timeoutMs = 10_000): Promise<string> {
  return timedFetch(`${BASE}${path}`, {}, timeoutMs);
}

export const SERENITY_SOURCE_URL = BASE;
