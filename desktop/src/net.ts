/**
 * Network helper ported from the sharer's `safeFetch` (v6 network-resilience).
 *
 * Three behaviours are load-bearing and were each fixed in response to a real
 * failure, so keep them:
 *   1. `connection: close` — undici keeps sockets alive across a laptop
 *      sleep/wake and then reuses a dead one; the first push after every wake
 *      failed until this was added.
 *   2. per-attempt abort at 12s — a stalled read must not hold the cycle open.
 *   3. 3 attempts with a short gap — genuine blips retry, real errors surface.
 */

const ATTEMPT_TIMEOUT_MS = 12_000;
const ATTEMPTS = 3;
const RETRY_GAP_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      return await fetch(url, {
        ...init,
        signal: ac.signal,
        headers: { ...(init.headers as Record<string, string> | undefined), connection: "close" },
      });
    } catch (e) {
      lastErr = e;
      if (attempt < ATTEMPTS) await sleep(RETRY_GAP_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Turn `retry-after` / rate-limit-reset headers into a delay in ms.
 * `retry-after` may be seconds or an HTTP date; reset headers may be epoch
 * seconds. Anything unparseable yields undefined so the caller falls back to
 * its own ladder.
 */
export function retryMsFrom(retryAfter: string | null, reset: string | null): number | undefined {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  if (reset) {
    const epoch = Number(reset);
    if (Number.isFinite(epoch) && epoch > 0) {
      const ms = epoch > 1e11 ? epoch : epoch * 1000;
      return Math.max(0, ms - Date.now());
    }
  }
  return undefined;
}
