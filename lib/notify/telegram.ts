import type { NotificationProvider, NotifyPayload, NotifyResult } from "./types";

/** Base URL for the Telegram Bot API sendMessage endpoint. */
const sendMessageUrl = (token: string) => `https://api.telegram.org/bot${token}/sendMessage`;

/** Base URL for the Telegram Bot API sendDocument endpoint (file upload). */
const sendDocumentUrl = (token: string) => `https://api.telegram.org/bot${token}/sendDocument`;

/**
 * Escape the three characters Telegram's HTML parse_mode treats as markup.
 * HTML mode (not MarkdownV2) is used deliberately: it only needs these three
 * escapes, so there's no fragile punctuation-escaping surface, and we can still
 * emit the few tags we use (`<b>`, `<a>`, `<code>`).
 */
export function escapeTelegramHTML(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function botToken(): string | null {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

export const telegramProvider: NotificationProvider = {
  channel: "telegram",

  isConfigured() {
    return botToken() != null;
  },

  async send(recipient, payload): Promise<NotifyResult> {
    const token = botToken();
    if (!token) return { outcome: "skipped", skipReason: "TELEGRAM_BOT_TOKEN not set" };
    // Telegram rejects empty messages with a 400 — guard so a malformed payload
    // becomes a clean skip rather than surfacing as "failed".
    if (!payload.text.trim()) return { outcome: "skipped", skipReason: "empty message" };

    let resp: Response;
    try {
      resp = await fetch(sendMessageUrl(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: recipient,
          text: payload.html ?? payload.text,
          parse_mode: payload.html ? "HTML" : undefined,
          disable_web_page_preview: true,
        }),
      });
    } catch (e) {
      return { outcome: "failed", errorMessage: e instanceof Error ? e.message : "network error" };
    }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return {
        outcome: "failed",
        errorMessage: `Telegram ${resp.status}: ${detail.slice(0, 200)}`.trim(),
      };
    }
    return { outcome: "sent" };
  },
};

/**
 * Low-level send for the connect/test flows that need to emit arbitrary HTML to
 * a chat_id (e.g. the "✅ Connected" reply). Plain text is derived by stripping
 * tags so a non-HTML reader still has a fallback.
 */
export async function sendTelegramMessage(
  chatId: string,
  html: string,
): Promise<NotifyResult> {
  return telegramProvider.send(chatId, { text: html.replace(/<[^>]+>/g, ""), html });
}

/**
 * Send a binary file (e.g. a rendered report PDF) to a chat via sendDocument
 * (multipart upload). Optional HTML caption (≤1024 chars) captions the file.
 * Uses the global fetch + FormData + Blob (Node ≥18 / Vercel Node 20+).
 */
export async function sendTelegramDocument(
  chatId: string,
  filename: string,
  bytes: Uint8Array,
  captionHtml?: string,
): Promise<NotifyResult> {
  const token = botToken();
  if (!token) return { outcome: "skipped", skipReason: "TELEGRAM_BOT_TOKEN not set" };

  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    // Copy into an ArrayBuffer-backed view so the DOM Blob type accepts it
    // (TS 5.7+ types Uint8Array over ArrayBufferLike, which Blob rejects).
    form.append("document", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), filename);
    if (captionHtml && captionHtml.trim()) {
      form.append("caption", captionHtml.slice(0, 1024));
      form.append("parse_mode", "HTML");
    }
    const resp = await fetch(sendDocumentUrl(token), { method: "POST", body: form });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return {
        outcome: "failed",
        errorMessage: `Telegram sendDocument ${resp.status}: ${detail.slice(0, 200)}`.trim(),
      };
    }
    return { outcome: "sent" };
  } catch (e) {
    return { outcome: "failed", errorMessage: e instanceof Error ? e.message : "network error" };
  }
}
