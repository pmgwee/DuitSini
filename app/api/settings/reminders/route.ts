import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sanitizeOffsets } from "@/lib/reminders/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// min(1) enforces "at least one reminder day" server-side (the UI also blocks
// unticking the last box). max(10) is a sane upper bound; the UI offers 4.
const bodySchema = z.object({
  offsets: z.array(z.number().int().min(0).max(60)).min(1).max(10),
});

function crossSiteBlocked(secFetchSite: string | null): boolean {
  if (!secFetchSite) return false;
  return secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none";
}

/**
 * POST — save the user's DEFAULT reminder schedule. Applies to every
 * subscription that hasn't customized its own offsets (NULL = inherit). Cloned
 * from the Telegram toggle route: Fetch-Metadata CSRF guard → session auth →
 * zod → RLS-scoped user_profiles upsert → structured JSON. Canonicalizes the
 * array (dedupe + sort desc) before storing.
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

  const canonical = sanitizeOffsets(parsed.data.offsets);
  const { error } = await supabase.from("user_profiles").upsert({
    user_id: user.id,
    reminder_offsets_days: canonical,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, offsets: canonical });
}

/**
 * GET — the user's current default reminder schedule (canonicalized). Used by the
 * subscription form so its "Use my default" state can show the actual global
 * values without prop-drilling them through the whole view tree. Session-authed;
 * a missing profile row degrades to the default schedule.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("reminder_offsets_days")
    .eq("user_id", user.id)
    .maybeSingle();
  return NextResponse.json({ ok: true, offsets: sanitizeOffsets(profile?.reminder_offsets_days ?? null) });
}
