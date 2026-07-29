import type { BillingCycle, Category, CurrencyCode } from "@/lib/constants";
import type { PaymentMethod } from "@/types/payment-method";

export type NotificationChannel = "telegram" | "whatsapp" | "email" | "in_app";

export type SubscriptionStatus = "active" | "trial" | "cancelled";

export type IconType = "provider" | "custom" | "monogram";

/**
 * A subscription record. Amounts are stored in major currency units
 * (e.g. dollars, not cents). `nextRenewalAt` is a cached, timezone-aware
 * instant; the canonical charge series is always derived from `startDate`
 * (or the trial-end date) + `billingCycle` via the renewal engine.
 */
export interface Subscription {
  id: string;
  userId: string;
  name: string;
  provider: string | null;
  category: Category;
  amount: number;
  currency: CurrencyCode;
  billingCycle: BillingCycle;
  intervalCount: number;
  planType: string | null;
  startDate: string; // YYYY-MM-DD (civil date)
  nextRenewalAt: string; // ISO datetime (UTC)
  freeTrialEndAt: string | null; // YYYY-MM-DD
  isTrial: boolean;
  /**
   * Civil date (YYYY-MM-DD) the subscription was cancelled/stopped, or null
   * while active. This is the single source of truth for "stopped" state — it
   * bounds the charge series so charges dated BEFORE this still count (past
   * history is preserved) and charges on/after drop. Set by `setCancelled`.
   */
  cancelledAt: string | null;
  unsubscribeUrl: string | null;
  iconType: IconType;
  iconUrl: string | null;
  color: string | null;
  notes: string | null;
  reminderOffsetsDays: number[] | null;
  reminderTimeLocal: string; // HH:mm
  notificationChannels: NotificationChannel[];
  createdAt: string;
  updatedAt: string;
  /** FK to payment_methods (write path). Null = unspecified / backfilled. */
  paymentMethodId: string | null;
  /** Resolved instrument, attached by repos at read time (mock/Supabase join). */
  paymentMethod?: PaymentMethod | null;
}
