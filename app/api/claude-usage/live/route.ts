import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A snapshot older than this is treated as "bridge offline" → manual fallback. */
const FRESH_MS = 3 * 60 * 1000;

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
  const fresh = ageMs < FRESH_MS;

  const payload = {
    five_hour: { utilization: data.five_hour_utilization, resets_at: data.five_hour_resets_at },
    seven_day: { utilization: data.seven_day_utilization, resets_at: data.seven_day_resets_at },
    limits: data.limits_json ?? null,
    refreshed_at: data.updated_at,
    cached: !fresh,
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
