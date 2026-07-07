import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { resolveBridgeUserId } from "@/lib/claude-usage/bridge-auth";
import type { Json } from "@/lib/supabase/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const windowSchema = z
  .object({
    utilization: z.number().min(0).max(1000).nullable(),
    resets_at: z.string().min(1).max(64).nullable(),
  })
  .nullable();

const limitSchema = z.object({
  key: z.string().max(64),
  label: z.string().max(80),
  group: z.enum(["session", "weekly"]),
  percent: z.number().min(0).max(1000).nullable(),
  resets_at: z.string().max(64).nullable(),
  severity: z.string().max(32).nullable().optional(),
});

const bodySchema = z.object({
  user_id: z.string().uuid().optional(),
  five_hour: windowSchema.optional(),
  seven_day: windowSchema.optional(),
  limits: z.array(limitSchema).max(40).nullable().optional(),
});

/**
 * Ingest endpoint for the local Claude Usage Bridge. Authenticated by a shared
 * secret (NOT a user session) so the companion can push without cookies. Writes
 * one snapshot row via the service role. The target user is pinned by
 * CLAUDE_BRIDGE_USER_ID when set (recommended), else taken from the body.
 */
export async function POST(req: NextRequest) {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Live bridge not configured on the server." },
      { status: 503 },
    );
  }
  const targetUser = await resolveBridgeUserId(req.headers.get("authorization"));
  if (!targetUser) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }

  const { five_hour, seven_day, limits } = parsed.data;
  const admin = createSupabaseAdminClient();
  const base = {
    user_id: targetUser,
    five_hour_utilization: five_hour?.utilization ?? null,
    five_hour_resets_at: five_hour?.resets_at ?? null,
    seven_day_utilization: seven_day?.utilization ?? null,
    seven_day_resets_at: seven_day?.resets_at ?? null,
    updated_at: new Date().toISOString(),
  };

  let { error } = await admin
    .from("claude_usage_live")
    .upsert({ ...base, limits_json: (limits ?? null) as Json });
  // Degrade gracefully if the limits_json column migration isn't applied yet:
  // still store the session/weekly totals so the widget keeps working.
  if (error && /limits_json/i.test(error.message)) {
    ({ error } = await admin.from("claude_usage_live").upsert(base));
  }
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
