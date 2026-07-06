import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const windowSchema = z
  .object({
    utilization: z.number().min(0).max(1000).nullable(),
    resets_at: z.string().min(1).max(64).nullable(),
  })
  .nullable();

const bodySchema = z.object({
  user_id: z.string().uuid().optional(),
  five_hour: windowSchema.optional(),
  seven_day: windowSchema.optional(),
});

/** Constant-time bearer check against CLAUDE_BRIDGE_SECRET. */
function authorized(header: string | null): boolean {
  const secret = process.env.CLAUDE_BRIDGE_SECRET;
  if (!secret || !header) return false;
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Ingest endpoint for the local Claude Usage Bridge. Authenticated by a shared
 * secret (NOT a user session) so the companion can push without cookies. Writes
 * one snapshot row via the service role. The target user is pinned by
 * CLAUDE_BRIDGE_USER_ID when set (recommended), else taken from the body.
 */
export async function POST(req: NextRequest) {
  if (!isAdminConfigured() || !process.env.CLAUDE_BRIDGE_SECRET) {
    return NextResponse.json(
      { ok: false, error: "Live bridge not configured on the server." },
      { status: 503 },
    );
  }
  if (!authorized(req.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }

  const targetUser = process.env.CLAUDE_BRIDGE_USER_ID || parsed.data.user_id;
  if (!targetUser) {
    return NextResponse.json(
      { ok: false, error: "No target user (set CLAUDE_BRIDGE_USER_ID or send user_id)." },
      { status: 400 },
    );
  }

  const { five_hour, seven_day } = parsed.data;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("claude_usage_live").upsert({
    user_id: targetUser,
    five_hour_utilization: five_hour?.utilization ?? null,
    five_hour_resets_at: five_hour?.resets_at ?? null,
    seven_day_utilization: seven_day?.utilization ?? null,
    seven_day_resets_at: seven_day?.resets_at ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
