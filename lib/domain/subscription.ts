import type { BillingCycle } from "@/lib/constants";
import type { Subscription, SubscriptionStatus } from "@/types/subscription";
import type { SubscriptionPatch } from "@/lib/validation/subscription";
import { daysUntil, toISODate } from "./dates";
import { monthlyEquivalent, yearlyEquivalent } from "./money";
import { chargesInRange, nextChargeOnOrAfter } from "./renewal";

/** The date the recurring charge series is anchored to. */
export function chargeAnchorISO(sub: Subscription): string {
  return sub.isTrial && sub.freeTrialEndAt ? sub.freeTrialEndAt : sub.startDate;
}

export function getStatus(sub: Subscription): SubscriptionStatus {
  if (sub.isCancelled) return "cancelled";
  if (sub.isPaused) return "paused";
  if (sub.isTrial && sub.freeTrialEndAt && daysUntil(sub.freeTrialEndAt) >= 0) {
    return "trial";
  }
  return "active";
}

export function isActive(sub: Subscription): boolean {
  return !sub.isCancelled && !sub.isPaused;
}

/** Next real charge date (civil), or null if paused/cancelled/expired one-off. */
export function getNextChargeDate(
  sub: Subscription,
  fromISO: string = toISODate(new Date()),
): string | null {
  if (!isActive(sub)) return null;
  return nextChargeOnOrAfter(chargeAnchorISO(sub), sub.billingCycle, sub.intervalCount, fromISO);
}

/** Normalized monthly cost; paused/cancelled subs contribute nothing. */
export function monthlyAmount(sub: Subscription): number {
  if (!isActive(sub)) return 0;
  return monthlyEquivalent(sub.amount, sub.billingCycle, sub.intervalCount);
}

export function yearlyAmount(sub: Subscription): number {
  if (!isActive(sub)) return 0;
  return yearlyEquivalent(sub.amount, sub.billingCycle, sub.intervalCount);
}

/** Charge dates for an active subscription within a civil-date range. */
export function chargeDatesInRange(
  sub: Subscription,
  startISO: string,
  endISO: string,
): string[] {
  if (!isActive(sub)) return [];
  return chargesInRange(
    chargeAnchorISO(sub),
    sub.billingCycle,
    sub.intervalCount,
    startISO,
    endISO,
  );
}

export function isTrialConvertingWithin(sub: Subscription, days: number): boolean {
  if (!sub.isTrial || !sub.freeTrialEndAt || !isActive(sub)) return false;
  const d = daysUntil(sub.freeTrialEndAt);
  return d >= 0 && d <= days;
}

/** Two-letter monogram used when no provider icon is available. */
export function getMonogram(sub: Subscription): string {
  const source = (sub.provider || sub.name).trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase() || "??";
}

/** Fields needed to derive the cached `next_renewal_at` instant. */
export interface RenewalFields {
  startDate: string;
  isTrial: boolean;
  freeTrialEndAt: string | null;
  billingCycle: BillingCycle;
  intervalCount: number;
  reminderTimeLocal: string;
}

/** Compute the cached next-renewal instant (UTC ISO) from renewal fields. */
export function computeNextRenewalInstant(fields: RenewalFields): string {
  const anchor = fields.isTrial && fields.freeTrialEndAt ? fields.freeTrialEndAt : fields.startDate;
  const nextDate =
    nextChargeOnOrAfter(anchor, fields.billingCycle, fields.intervalCount, toISODate(new Date())) ??
    fields.startDate;
  const time = /^\d{2}:\d{2}$/.test(fields.reminderTimeLocal) ? fields.reminderTimeLocal : "09:00";
  return `${nextDate}T${time}:00.000Z`;
}

/** Apply a validated patch onto a subscription in place (shared by repos). */
export function applySubscriptionPatch(target: Subscription, patch: SubscriptionPatch): void {
  if (patch.name !== undefined) target.name = patch.name;
  if (patch.provider !== undefined) target.provider = patch.provider ?? null;
  if (patch.category !== undefined) target.category = patch.category;
  if (patch.amount !== undefined) target.amount = patch.amount;
  if (patch.currency !== undefined) target.currency = patch.currency;
  if (patch.billingCycle !== undefined) target.billingCycle = patch.billingCycle;
  if (patch.intervalCount !== undefined) target.intervalCount = patch.intervalCount;
  if (patch.planType !== undefined) target.planType = patch.planType ?? null;
  if (patch.startDate !== undefined) target.startDate = patch.startDate;
  if (patch.freeTrialEndAt !== undefined) target.freeTrialEndAt = patch.freeTrialEndAt ?? null;
  if (patch.isTrial !== undefined) target.isTrial = patch.isTrial;
  if (patch.unsubscribeUrl !== undefined) {
    target.unsubscribeUrl = patch.unsubscribeUrl ? patch.unsubscribeUrl : null;
  }
  if (patch.color !== undefined) target.color = patch.color ?? null;
  if (patch.notes !== undefined) target.notes = patch.notes ?? null;
  if (patch.reminderOffsetsDays !== undefined) target.reminderOffsetsDays = patch.reminderOffsetsDays;
  if (patch.reminderTimeLocal !== undefined) target.reminderTimeLocal = patch.reminderTimeLocal;
  if (patch.notificationChannels !== undefined) {
    target.notificationChannels = patch.notificationChannels;
  }
}
