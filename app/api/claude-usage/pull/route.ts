import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { resolveBridgeUserId } from "@/lib/claude-usage/bridge-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — the signed-in user asks the local bridge to fetch fresh usage now.
 * We stamp `pull_requested_at`; the bridge polls it (every few seconds) and
 * fetches + pushes immediately when it changes. Uses the service role because
 * the snapshot row is otherwise service-role-only.
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
  const { error } = await admin
    .from("claude_usage_live")
    .upsert({ user_id: user.id, pull_requested_at: new Date().toISOString() });
  if (error) {
    // Column not migrated yet, or other DB error — report but don't 500 the UI.
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
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
