import { isPreservedSourceStale, streamSchema, type UsageStream } from "./protocol";
import { usageStreamKey } from "./codex-accounts";

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
  const seen = new Set(incoming.map((stream) => usageStreamKey(stream)));
  const hasIdentifiedCodex = incoming.some(
    (stream) => stream.source === "codex" && Boolean(stream.account_key),
  );

  for (const previousValue of previous ?? []) {
    const parsed = streamSchema.safeParse(previousValue);
    if (!parsed.success) continue;
    const candidate = parsed.data;
    const key = usageStreamKey(candidate);
    if (seen.has(key)) continue;
    // Once a current producer identifies Codex accounts, an old anonymous
    // codex stream must not be carried forward and mistaken for either seat.
    if (hasIdentifiedCodex && candidate.source === "codex" && !candidate.account_key) continue;
    // Retired collector, not a blip — let it go instead of preserving a ghost.
    if (isPreservedSourceStale(parsed.data.observed_at, now)) continue;
    seen.add(key);
    next.push({
      ...candidate,
      cached: true,
      state: "offline",
      status_message: "Collector unavailable; showing the last reading.",
    });
    if (next.length >= 6) break;
  }

  return next;
}
