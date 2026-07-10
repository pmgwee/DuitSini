import type { NotificationChannel } from "@/types/subscription";
import type { NotificationProvider } from "./types";
import { telegramProvider } from "./telegram";
import { whatsappProvider } from "./whatsapp";

/**
 * Channel → provider registry. `email` and `in_app` have no provider in Phase 3,
 * so `getProvider` returns null for them (the sweep records "skipped"). Adding a
 * channel later means implementing a `NotificationProvider` and registering it
 * here — nothing else in the sweep changes.
 */
const REGISTRY: Partial<Record<NotificationChannel, NotificationProvider>> = {
  telegram: telegramProvider,
  whatsapp: whatsappProvider,
};

/** The provider for a channel, or null if the channel has no transport. */
export function getProvider(channel: NotificationChannel): NotificationProvider | null {
  return REGISTRY[channel] ?? null;
}

export { escapeTelegramHTML, sendTelegramMessage } from "./telegram";
export type {
  NotificationProvider,
  NotifyPayload,
  NotifyResult,
  NotifyOutcome,
} from "./types";
