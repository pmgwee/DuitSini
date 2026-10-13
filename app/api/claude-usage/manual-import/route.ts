import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { parseManualUsageImport, buildGoogleUsageStreams } from "@/lib/claude-usage/google-ai-pro";
import { mergeUsageStreams } from "@/lib/claude-usage/stream-continuity";
import type { Json } from "@/lib/supabase/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Server is not configured." },
      { status: 503 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  if (!body || typeof body.text !== "string" || !body.text.trim()) {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid usage text to import." },
      { status: 400 },
    );
  }

  const nowMs = Date.now();
  const pools = parseManualUsageImport(body.text, nowMs);
  if (!pools) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Could not parse quota data. Please paste valid output from 'agy -p \"/usage\"' or Antigravity JSON.",
      },
      { status: 422 },
    );
  }

  // Create the two Google AI Pro streams
  const newStreams = buildGoogleUsageStreams(pools, {
    state: "cached",
    statusMessage: "Manual import via agy /usage",
  });

  const admin = createSupabaseAdminClient();
  const { data: previous } = await admin
    .from("claude_usage_live")
    .select("streams_json")
    .eq("user_id", user.id)
    .maybeSingle();

  const merged = mergeUsageStreams(
    newStreams,
    Array.isArray(previous?.streams_json) ? previous.streams_json : null,
    nowMs,
  );

  const primary =
    merged.find((s) => s.source === "claude_pro" || s.source === "claude") ??
    merged[0];

  const observedAt = new Date(nowMs).toISOString();

  const { error: upsertError } = await admin.from("claude_usage_live").upsert(
    {
      user_id: user.id,
      five_hour_utilization: primary.five_hour?.utilization ?? null,
      five_hour_resets_at: primary.five_hour?.resets_at ?? null,
      seven_day_utilization: primary.seven_day?.utilization ?? null,
      seven_day_resets_at: primary.seven_day?.resets_at ?? null,
      updated_at: observedAt,
      streams_json: merged as unknown as Json,
      limits_json: (primary.limits ?? null) as Json,
      provider_json: (primary.provider ?? null) as Json,
    },
    { onConflict: "user_id" },
  );

  if (upsertError) {
    return NextResponse.json(
      { ok: false, error: `Failed to save quota: ${upsertError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, streams: merged });
}

