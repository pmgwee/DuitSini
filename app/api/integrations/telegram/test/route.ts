import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sendTelegramMessage } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST — send a test message to the caller's own linked Telegram chat.
 * Session-authed (the member is verifying their own connect). Surfaces the
 * provider error verbatim on failure so the settings card can show why.
 */
export async function POST() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("telegram_chat_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const chatId = profile?.telegram_chat_id;
  if (!chatId) {
    return NextResponse.json({ ok: false, error: "Connect Telegram first." }, { status: 400 });
  }

  const result = await sendTelegramMessage(
    chatId,
    "✅ <b>Test message</b> — your Subscription Agent reminders are wired up.",
  );
  if (result.outcome === "sent") return NextResponse.json({ ok: true });
  if (result.outcome === "skipped") {
    return NextResponse.json(
      { ok: false, error: result.skipReason ?? "skipped" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    { ok: false, error: result.errorMessage ?? "failed" },
    { status: 502 },
  );
}
