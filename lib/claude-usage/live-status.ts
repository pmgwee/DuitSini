export type UsageDeliveryStatus = "connecting" | "live" | "cached" | "error";

interface LivePayloadShape {
  error?: string;
  streams?: readonly { source?: string; label?: string; state?: string }[] | null;
}

export function classifyLivePayload(payload: LivePayloadShape): Exclude<UsageDeliveryStatus, "connecting"> {
  const hasStreams = Boolean(
    payload.streams?.some((stream) => Boolean(stream?.source && stream?.label)),
  );
  if (payload.error) return payload.error === "stale" && hasStreams ? "cached" : "error";
  return hasStreams ? "live" : "error";
}
