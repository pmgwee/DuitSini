import { isPreservedSourceStale, streamSchema, type UsageStream } from "./protocol";

/**
 * A producer cycle is allowed to fail per source. Preserve any omitted source
 * as an explicitly stale last-known reading instead of deleting its dashboard
 * section when the new `streams_json` row replaces the old one — but only for a
 * bounded time (PRESERVED_SOURCE_TTL_MS). A source silent longer than that is a
 * permanently-removed collector, not a transient outage, and is dropped so its
 * card stops masquerading as fresh (the row-wide `updated_at` updates on every
 * push, which made a 5-day-old retired stream read as "0m ago").
 *
 * `now` is taken explicitly so the expiry is deterministic and testable; the
 * ingest route passes the wall-clock write time.
 */
export function mergeUsageStreams(
  incoming: UsageStream[],
  previous: readonly unknown[] | null | undefined,
  now: number = Date.now(),
): UsageStream[] {
  const next = [...incoming];
  const seen = new Set(incoming.map((stream) => stream.source));

  for (const candidate of previous ?? []) {
    const parsed = streamSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.source)) continue;
    // Retired collector, not a blip — let it go instead of preserving a ghost.
    if (isPreservedSourceStale(parsed.data.observed_at, now)) continue;
    seen.add(parsed.data.source);
    next.push({
      ...parsed.data,
      cached: true,
      state: "offline",
      status_message: "Collector unavailable; showing the last reading.",
    });
    if (next.length >= 6) break;
  }

  return next;
}
