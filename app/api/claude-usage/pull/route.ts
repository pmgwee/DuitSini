import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { resolveBridgeUserId } from "@/lib/claude-usage/bridge-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side floor between honored pulls. Every honored pull costs one call
 * against Anthropic's per-account usage-endpoint budget (~330–390 calls/day
 * trips a 429 with hours-long recovery), on top of the sharer's ~192/day at
 * the 300s default cadence. 60s caps spam at +60/h regardless of how many
 * tabs or devices hammer the button — the client mirrors this as a countdown.
 */
const PULL_COOLDOWN_S = 60;

/**
 * POST — the signed-in user asks the local bridge to fetch fresh usage now.
 * We stamp `pull_requested_at`; the bridge polls it (every few seconds) and
 * fetches + pushes immediately when it changes. Uses the service role because
 * the snapshot row is otherwise service-role-only. Throttled: a pull within
 * PULL_COOLDOWN_S of the last honored one returns 429 + next_allowed_at
 * instead of a fresh stamp, protecting the member's own Anthropic budget.
 */
export async function POST() {
  if (!isAdminConfigured()) {
    return NextResponse.json({ ok: false, error: "not configured" }, { status: 503 });
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const now = Date.now();

  const { data: row } = await admin
    .from("claude_usage_live")
    .select("pull_requested_at")
    .eq("user_id", user.id)
    .maybeSingle();
  const lastMs = row?.pull_requested_at ? Date.parse(row.pull_requested_at) : 0;
  if (Number.isFinite(lastMs) && lastMs > 0 && now - lastMs < PULL_COOLDOWN_S * 1000) {
    const nextAllowedMs = lastMs + PULL_COOLDOWN_S * 1000;
    return NextResponse.json(
      {
        ok: false,
        throttled: true,
        retry_after_s: Math.ceil((nextAllowedMs - now) / 1000),
        next_allowed_at: new Date(nextAllowedMs).toISOString(),
        cooldown_s: PULL_COOLDOWN_S,
      },
      { status: 429 },
    );
  }

  const { error } = await admin
    .from("claude_usage_live")
    .upsert({ user_id: user.id, pull_requested_at: new Date(now).toISOString() });
  if (error) {
    // Column not migrated yet, or other DB error — report but don't 500 the UI.
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    cooldown_s: PULL_COOLDOWN_S,
    next_allowed_at: new Date(now + PULL_COOLDOWN_S * 1000).toISOString(),
  });
}

/**
 * GET — the bridge polls this (bearer secret) to learn whether a pull was
 * requested since it last checked. Cheap: no Anthropic call, just a column read.
 */
export async function GET(req: NextRequest) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ pull_requested_at: null }, { status: 503 });
  }
  const targetUser = await resolveBridgeUserId(req.headers.get("authorization"));
  if (!targetUser) {
    return NextResponse.json({ pull_requested_at: null }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("claude_usage_live")
    .select("pull_requested_at")
    .eq("user_id", targetUser)
    .maybeSingle();
  return NextResponse.json({ pull_requested_at: data?.pull_requested_at ?? null });
}
