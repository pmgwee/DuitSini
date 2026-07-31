import { streamSchema, type UsageStream } from "./protocol";

/**
 * A producer cycle is allowed to fail per source. Preserve any omitted source
 * as an explicitly stale last-known reading instead of deleting its dashboard
 * section when the new `streams_json` row replaces the old one.
 */
export function mergeUsageStreams(
  incoming: UsageStream[],
  previous: readonly unknown[] | null | undefined,
): UsageStream[] {
  const next = [...incoming];
  const seen = new Set(incoming.map((stream) => stream.source));

  for (const candidate of previous ?? []) {
    const parsed = streamSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.source)) continue;
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
