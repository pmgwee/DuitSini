import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Both flags are optional but at least one must be present. A missing flag is
// left untouched (so the card can save one toggle without resetting the other).
const bodySchema = z
  .object({
    monthly: z.boolean().optional(),
    yearly: z.boolean().optional(),
  })
  .refine((b) => b.monthly !== undefined || b.yearly !== undefined, {
    message: "provide at least one of monthly/yearly",
  });

/** Fetch-Metadata CSRF guard — cloned from the sibling settings routes. */
function crossSiteBlocked(secFetchSite: string | null): boolean {
  if (!secFetchSite) return false;
  return secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none";
}

/**
 * POST — save the user's report-generation toggles (`monthly_report_enabled` /
 * `yearly_report_enabled` on `user_profiles`). Session-authed (RLS) + CSRF. The
 * flags gate CRON generation; reports always appear in-app when generated, so
 * turning a flag off just stops future statements for that period.
 */
export async function POST(req: NextRequest) {
  if (crossSiteBlocked((await headers()).get("sec-fetch-site"))) {
    return NextResponse.json({ ok: false, error: "Cross-site request blocked." }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }

  const update: {
    monthly_report_enabled?: boolean;
    yearly_report_enabled?: boolean;
    updated_at: string;
  } = { updated_at: new Date().toISOString() };
  if (parsed.data.monthly !== undefined) update.monthly_report_enabled = parsed.data.monthly;
  if (parsed.data.yearly !== undefined) update.yearly_report_enabled = parsed.data.yearly;

  const { error } = await supabase
    .from("user_profiles")
    .upsert({ user_id: user.id, ...update });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
