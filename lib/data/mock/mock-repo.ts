import type { Subscription } from "@/types/subscription";
import type { SubscriptionInput } from "@/lib/validation/subscription";
import {
  applySubscriptionPatch,
  computeNextRenewalInstant,
} from "@/lib/domain/subscription";
import { DEMO_USER_ID, type SubscriptionRepository } from "../types";
import { seedSubscriptions } from "./seed";
import { paymentMethodStore } from "./payment-method-store";

// In-memory store. Persists for the lifetime of the server process (dev use).
const store = new Map<string, Subscription>();
for (const sub of seedSubscriptions()) store.set(sub.id, sub);
let sequence = store.size;

function nextId(): string {
  return `sub_${(++sequence).toString().padStart(3, "0")}`;
}

/**
 * Resolve a subscription's payment method from the shared in-memory store — the
 * mock mirror of the Supabase nested-select join. A missing or stale id (e.g.
 * the method was deleted) resolves to null, so the badge simply hides — same
 * graceful behavior as the DB's ON DELETE SET NULL.
 */
function attachMethod(sub: Subscription): Subscription {
  sub.paymentMethod = sub.paymentMethodId
    ? (paymentMethodStore.get(sub.paymentMethodId) ?? null)
    : null;
  return sub;
}

function ownedBy(userId: string, id: string): Subscription | null {
  const sub = store.get(id);
  return sub && sub.userId === userId ? sub : null;
}

export const mockSubscriptionRepository: SubscriptionRepository = {
  async list(userId) {
    return [...store.values()]
      .filter((sub) => sub.userId === userId)
      .sort((a, b) => a.nextRenewalAt.localeCompare(b.nextRenewalAt))
      .map(attachMethod);
  },

  async get(userId, id) {
    const sub = ownedBy(userId, id);
    return sub ? attachMethod(sub) : null;
  },

  async create(userId, input: SubscriptionInput) {
    const timestamp = new Date().toISOString();
    const sub: Subscription = {
      id: nextId(),
      userId,
      name: input.name,
      provider: input.provider ?? input.name,
      category: input.category,
      amount: input.amount,
      currency: input.currency,
      billingCycle: input.billingCycle,
      intervalCount: input.intervalCount,
      planType: input.planType ?? null,
      startDate: input.startDate,
      nextRenewalAt: "",
      freeTrialEndAt: input.freeTrialEndAt ?? null,
      isTrial: input.isTrial,
      isPaused: false,
      isCancelled: false,
      unsubscribeUrl: input.unsubscribeUrl ? input.unsubscribeUrl : null,
      iconType: "monogram",
      iconUrl: null,
      color: input.color ?? null,
      notes: input.notes ?? null,
      reminderOffsetsDays: input.reminderOffsetsDays ?? null,
      reminderTimeLocal: input.reminderTimeLocal,
      notificationChannels: input.notificationChannels,
      paymentMethodId: input.paymentMethodId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    sub.nextRenewalAt = computeNextRenewalInstant(sub);
    store.set(sub.id, sub);
    return attachMethod(sub);
  },

  async update(userId, id, patch) {
    const current = ownedBy(userId, id);
    if (!current) return null;
    applySubscriptionPatch(current, patch);
    current.updatedAt = new Date().toISOString();
    current.nextRenewalAt = computeNextRenewalInstant(current);
    store.set(id, current);
    return attachMethod(current);
  },

  async remove(userId, id) {
    if (!ownedBy(userId, id)) return false;
    return store.delete(id);
  },

  async setPaused(userId, id, paused) {
    const current = ownedBy(userId, id);
    if (!current) return null;
    current.isPaused = paused;
    current.updatedAt = new Date().toISOString();
    store.set(id, current);
    return attachMethod(current);
  },

  async setCancelled(userId, id, cancelled) {
    const current = ownedBy(userId, id);
    if (!current) return null;
    current.isCancelled = cancelled;
    current.updatedAt = new Date().toISOString();
    store.set(id, current);
    return attachMethod(current);
  },
};

export { DEMO_USER_ID };
