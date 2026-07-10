import type { NotificationChannel } from "@/types/subscription";

/**
 * A notification to send. `text` is the plain-text canonical form (always
 * present — used for logs and any future plain channel); `html` is an optional
 * HTML rendering for channels that parse markup (Telegram's parse_mode=HTML).
 * Callers are responsible for escaping user-controlled values (see
 * `escapeTelegramHTML`); providers never re-interpret markup.
 */
export interface NotifyPayload {
  text: string;
  html?: string;
}

export type NotifyOutcome = "sent" | "skipped" | "failed";

export interface NotifyResult {
  outcome: NotifyOutcome;
  /** Populated when outcome === "failed". */
  errorMessage?: string;
  /** Populated when outcome === "skipped". */
  skipReason?: string;
}

/**
 * A dumb transport. No DB access, no retry orchestration, no knowledge of the
 * delivery ledger — just "send this payload to this recipient." A provider that
 * isn't configured returns outcome "skipped" rather than throwing, so a missing
 * or rejected channel never aborts a sweep.
 */
export interface NotificationProvider {
  readonly channel: NotificationChannel;
  /** True when the provider's env credentials are present. */
  isConfigured(): boolean;
  /** Send `payload` to `recipient`. Never throws — failures are returned. */
  send(recipient: string, payload: NotifyPayload): Promise<NotifyResult>;
}
