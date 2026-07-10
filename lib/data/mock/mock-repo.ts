import type { Subscription } from "@/types/subscription";
import type { SubscriptionInput } from "@/lib/validation/subscription";
import {
  applySubscriptionPatch,
  computeNextRenewalInstant,
} from "@/lib/domain/subscription";
import { DEMO_USER_ID, type SubscriptionRepository } from "../types";
import { seedSubscriptions } from "./seed";

// In-memory store. Persists for the lifetime of the server process (dev use).
const store = new Map<string, Subscription>();
for (const sub of seedSubscriptions()) store.set(sub.id, sub);
let sequence = store.size;

function nextId(): string {
  return `sub_${(++sequence).toString().padStart(3, "0")}`;
}

function ownedBy(userId: string, id: string): Subscription | null {
  const sub = store.get(id);
  return sub && sub.userId === userId ? sub : null;
}

export const mockSubscriptionRepository: SubscriptionRepository = {
  async list(userId) {
    return [...store.values()]
      .filter((sub) => sub.userId === userId)
      .sort((a, b) => a.nextRenewalAt.localeCompare(b.nextRenewalAt));
  },

  async get(userId, id) {
    return ownedBy(userId, id);
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    sub.nextRenewalAt = computeNextRenewalInstant(sub);
    store.set(sub.id, sub);
    return sub;
  },

  async update(userId, id, patch) {
    const current = ownedBy(userId, id);
    if (!current) return null;
    applySubscriptionPatch(current, patch);
    current.updatedAt = new Date().toISOString();
    current.nextRenewalAt = computeNextRenewalInstant(current);
    store.set(id, current);
    return current;
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
    return current;
  },

  async setCancelled(userId, id, cancelled) {
    const current = ownedBy(userId, id);
    if (!current) return null;
    current.isCancelled = cancelled;
    current.updatedAt = new Date().toISOString();
    store.set(id, current);
    return current;
  },
};

export { DEMO_USER_ID };
