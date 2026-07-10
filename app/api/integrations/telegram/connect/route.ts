import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createTelegramLinkCode } from "@/lib/notify/telegram-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same Fetch-Metadata CSRF guard as the bridge mint routes: this is a GET that
 * mints a (HMAC, time-limited) link code purely on the session cookie, so a
 * cross-site forced navigation must not be able to trigger it. Absent header
 * (old browsers) falls through to the session check.
 */
function crossSiteBlocked(secFetchSite: string | null): boolean {
  if (!secFetchSite) return false;
  return secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none";
}

/**
 * GET — mint a 15-minute Telegram connect link for the signed-in member. Returns
 * `{ ok, url }` where `url` is `https://t.me/<bot>?start=<code>`. The code is
 * stateless (HMAC), so this route writes nothing and needs no new table.
 */
export async function GET(_req: NextRequest) {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!botUsername || !webhookSecret) {
    return NextResponse.json(
      { ok: false, error: "Telegram isn't configured on the server." },
      { status: 503 },
    );
  }

  if (crossSiteBlocked((await headers()).get("sec-fetch-site"))) {
    return NextResponse.json({ ok: false, error: "Cross-site request blocked." }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Please sign in first." }, { status: 401 });
  }

  const code = createTelegramLinkCode(user.id);
  const username = botUsername.replace(/^@/, "");
  const url = `https://t.me/${username}?start=${code}`;
  return NextResponse.json({ ok: true, url }, { headers: { "Cache-Control": "no-store" } });
}
