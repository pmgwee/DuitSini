import { sendTelegramMessage } from "./telegram";

/**
 * Fire-and-forget ops alert to the maintainer's chat. No-op unless
 * `OPS_ALERT_TELEGRAM_CHAT_ID` is set (and `TELEGRAM_BOT_TOKEN` is configured —
 * `sendTelegramMessage` skips cleanly otherwise). Never throws: a failed alert
 * must never break the sweep that triggered it.
 *
 * Used by the reports cron to page on failure (sweep threw, or `failed > 0`, or
 * the soft time budget truncated the run). Silent when green.
 */
export async function sendOpsAlert(text: string): Promise<void> {
  const chatId = process.env.OPS_ALERT_TELEGRAM_CHAT_ID;
  if (!chatId || !chatId.trim()) return;
  try {
    // HTML mode, so wrap the detail in <pre> for readability of stack traces.
    await sendTelegramMessage(
      chatId.trim(),
      `⚠️ <b>Reports sweep</b>\n<pre>${escapeForPre(text)}</pre>`,
    );
  } catch {
    // Swallow — ops alerts are strictly best-effort.
  }
}

/** Escape `<`, `>`, `&` for a Telegram <pre> block (no other markup needed). */
function escapeForPre(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
