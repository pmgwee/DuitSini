import { type NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { verifyTelegramLinkCode } from "@/lib/notify/telegram-link";
import { sendTelegramMessage } from "@/lib/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal shape of a Telegram Update we act on (/start text + chat id). */
interface TelegramUpdate {
  message?: {
    text?: string;
    chat?: { id?: number | string };
  };
}

const OK = NextResponse.json({ ok: true });

/**
 * POST — Telegram webhook. Verifies the secret-token header, then handles a
 * `/start <code>` deep link: verifies the HMAC code, links the chat to the
 * member's profile, and replies in-chat.
 *
 * ALWAYS returns 200 `{ok:true}` — even on a bad/expired code or a missing
 * header — replying with a friendly in-chat message instead. Telegram retries
 * any non-2xx delivery, so surfacing an error status would hammer this route.
 */
export async function POST(req: NextRequest) {
  if (!isAdminConfigured()) return OK;

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const gotSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || gotSecret !== secret) {
    // Don't reveal whether the secret matched — just accept and drop.
    return OK;
  }

  const body = (await req.json().catch(() => null)) as TelegramUpdate | null;
  const message = body?.message;
  const text = message?.text;
  const chatId = message?.chat?.id;
  if (!text || chatId == null) return OK;
  const chatIdStr = String(chatId);

  // Only `/start <code>` drives the connect flow. Anything else is ignored.
  if (!text.startsWith("/start")) return OK;
  const code = text.replace(/^\/start\s*/, "").trim();
  if (!code) {
    await sendTelegramMessage(
      chatIdStr,
      "Open your dashboard and tap <b>Connect Telegram</b> to link this chat.",
    );
    return OK;
  }

  const verified = verifyTelegramLinkCode(code);
  if (!verified.ok) {
    await sendTelegramMessage(
      chatIdStr,
      "⚠️ That link " + (verified.reason === "expired" ? "expired" : "is invalid") +
        ". Open your dashboard and tap Connect again.",
    );
    return OK;
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("user_profiles").upsert({
    user_id: verified.userId,
    telegram_chat_id: chatIdStr,
    telegram_enabled: true,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[telegram/webhook] profile upsert failed:", error.message);
    await sendTelegramMessage(chatIdStr, "Couldn't save your chat. Try the connect link again.");
    return OK;
  }

  await sendTelegramMessage(
    chatIdStr,
    "✅ <b>Connected</b> — you'll get renewal reminders here.",
  );
  return OK;
}
