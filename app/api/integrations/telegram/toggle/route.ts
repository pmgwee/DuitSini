import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ enabled: z.boolean() });

function crossSiteBlocked(secFetchSite: string | null): boolean {
  if (!secFetchSite) return false;
  return secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none";
}

/**
 * POST — enable/disable Telegram reminders for the signed-in member (writes
 * `user_profiles.telegram_enabled`). Session-authed + Fetch-Metadata guarded
 * like the other state-changing integration routes.
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

  const { error } = await supabase.from("user_profiles").upsert({
    user_id: user.id,
    telegram_enabled: parsed.data.enabled,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
