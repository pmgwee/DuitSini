import { DEFAULT_REMINDER_OFFSETS } from "@/lib/constants";

/**
 * In-memory cache of the signed-in user's GLOBAL reminder schedule — the
 * offsets a subscription inherits when it hasn't customized its own.
 *
 * The Add/Edit subscription form renders its "Following your default schedule"
 * chips from this value. Fetching /api/settings/reminders on every form open
 * caused a visible flash: the chips first painted the [7,3,1] fallback, then
 * snapped to the user's real schedule once the fetch resolved — and this
 * repeated on *every* open. Caching the resolved value means the first open
 * pays one round-trip (a neutral placeholder shows meanwhile) and every later
 * open reads the cached value synchronously, so nothing flashes.
 *
 * primeGlobalReminderDefaults() lets the settings card push the just-saved
 * schedule in, so the cache can't go stale mid-session.
 */

let inflight: Promise<number[]> | null = null;
let cached: number[] | null = null;

/** Fetch the global schedule once per session (or after invalidation/prime). */
export function getGlobalReminderDefaults(): Promise<number[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async (): Promise<number[]> => {
    let result: number[];
    try {
      const r = await fetch("/api/settings/reminders", {
        headers: { Accept: "application/json" },
      });
      const d = r.ok ? ((await r.json().catch(() => null)) as { offsets?: number[] } | null) : null;
      result =
        d && Array.isArray(d.offsets) && d.offsets.length
          ? d.offsets
          : [...DEFAULT_REMINDER_OFFSETS];
    } catch {
      result = [...DEFAULT_REMINDER_OFFSETS];
    }
    cached = result;
    inflight = null;
    return result;
  })();
  return inflight;
}

/** Synchronously read the already-resolved schedule, or null if not yet known. */
export function readGlobalReminderDefaults(): number[] | null {
  return cached;
}

/** Seed the cache with a known-good value (e.g. right after settings saves it). */
export function primeGlobalReminderDefaults(offsets: number[]): void {
  cached = [...offsets];
  inflight = null;
}
