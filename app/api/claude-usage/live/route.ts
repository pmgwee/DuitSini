import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How long a snapshot counts as "live", derived from the sharer's own
 * self-reported push cadence (v6.2+): two full cycles + grace, so jitter or a
 * single failed push never flaps the widget to the manual fallback — only two
 * consecutive missed pushes (a real outage) do. Rows from older sharers carry
 * no cadence; assume the 300s default (→ 11 min window). The clamp mirrors the
 * sharer's own 120–3600s bounds so a corrupt value can't pin the widget live.
 */
const DEFAULT_PUSH_SECONDS = 300;
const GRACE_MS = 60 * 1000;
function staleAfterMs(pushSeconds: number | null | undefined): number {
  const cadence = Math.min(3600, Math.max(120, pushSeconds ?? DEFAULT_PUSH_SECONDS));
  return cadence * 2 * 1000 + GRACE_MS;
}

/** One usage stream as stored in streams_json (validated loosely at read). */
type StreamRow = {
  source: string;
  label: string;
  five_hour?: { utilization: number | null; resets_at: string | null } | null;
  seven_day?: { utilization: number | null; resets_at: string | null } | null;
  limits?: Json | null;
  provider?: Json | null;
  cached?: boolean;
  observed_at?: string | null;
};

/**
 * Same-origin read of the signed-in user's live Claude usage snapshot (pushed
 * by the local bridge). RLS restricts the row to its owner. Returns an `error`
 * field when there's no snapshot or it's stale, which the widget uses to fall
 * back to the manual estimate.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("claude_usage_live")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "db", message: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({
      error: "no_data",
      message: "Live companion not detected — run the local Claude Usage Bridge to see real usage.",
    });
  }

  const ageMs = Date.now() - new Date(data.updated_at).getTime();
  const fresh = ageMs < staleAfterMs(data.push_seconds);

  // Normalize to a streams array. Newer rows carry streams_json (one or more
  // sources, e.g. Claude Pro + GLM); older rows synthesize a single stream
  // from the legacy scalar columns so the multi-stream UI still has data.
  const streams = Array.isArray(data.streams_json)
    ? (data.streams_json as StreamRow[])
    : [
        {
          source: "claude",
          label: "Claude",
          five_hour: { utilization: data.five_hour_utilization, resets_at: data.five_hour_resets_at },
          seven_day: { utilization: data.seven_day_utilization, resets_at: data.seven_day_resets_at },
          limits: data.limits_json ?? null,
          provider: data.provider_json ?? null,
        },
      ];

  // Legacy single-source fields still mirror the primary stream for any older
  // reader. Prefer a Claude-subscription source so it reflects real account
  // usage rather than a gateway.
  const primary =
    streams.find((s) => s.source === "claude_pro" || s.source === "claude") ?? streams[0];

  const payload = {
    five_hour: primary?.five_hour ?? null,
    seven_day: primary?.seven_day ?? null,
    limits: primary?.limits ?? null,
    provider: primary?.provider ?? null,
    streams,
    refreshed_at: data.updated_at,
    cached: !fresh,
    sharer_version: data.sharer_version,
  };

  if (!fresh) {
    const mins = Math.round(ageMs / 60000);
    return NextResponse.json({
      ...payload,
      error: "stale",
      message: `Bridge offline — last update ${mins} min ago. Showing a manual estimate.`,
    });
  }
  return NextResponse.json(payload);
}
