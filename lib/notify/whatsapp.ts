import type { NotificationProvider, NotifyResult } from "./types";

/**
 * WhatsApp Cloud API transport — Phase 3 ships this as a pluggable STUB only.
 * It always reports "skipped: not configured", so a subscription that lists
 * WhatsApp in its channels is recorded as skipped (audit-able in the ledger)
 * without aborting the sweep. The real transport is a later phase; wiring it
 * means implementing `send` against the Cloud API and flipping `isConfigured`.
 */
export const whatsappProvider: NotificationProvider = {
  channel: "whatsapp",

  isConfigured() {
    return false;
  },

  async send(): Promise<NotifyResult> {
    return { outcome: "skipped", skipReason: "WhatsApp not configured" };
  },
};
