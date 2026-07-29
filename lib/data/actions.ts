"use server";

import { revalidatePath } from "next/cache";
import { getEffectiveUserId, getSubscriptionRepository, getPaymentMethodRepository } from "./index";
import {
  subscriptionInputSchema,
  subscriptionPatchSchema,
  type SubscriptionInput,
  type SubscriptionPatch,
} from "@/lib/validation/subscription";
import {
  paymentMethodInputSchema,
  paymentMethodPatchSchema,
  type PaymentMethodInput,
  type PaymentMethodPatch,
} from "@/lib/validation/payment-method";
import type { PaymentMethod } from "@/types/payment-method";

/**
 * Subscription mutations, scoped to the signed-in user (or the demo user in
 * mock mode) via the repository. Inputs are re-validated server-side with Zod —
 * the client's TypeScript types are erased at runtime, so a crafted payload
 * must not reach the repository. Each revalidates the subscriptions route.
 */
export async function createSubscription(input: SubscriptionInput): Promise<void> {
  const parsed = subscriptionInputSchema.parse(input);
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  await repo.create(userId, parsed);
  revalidatePath("/subscriptions");
}

export async function updateSubscription(
  id: string,
  patch: SubscriptionPatch,
): Promise<void> {
  const parsed = subscriptionPatchSchema.parse(patch);
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  await repo.update(userId, id, parsed);
  revalidatePath("/subscriptions");
}

export async function deleteSubscription(id: string): Promise<void> {
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  await repo.remove(userId, id);
  revalidatePath("/subscriptions");
}

/**
 * Stop (`cancelled = true`) or restore (`cancelled = false`) a subscription.
 * Stopping stamps `cancelledAt = today`, which bounds the charge series so past
 * charges stay on record and future ones drop. Restoring clears `cancelledAt`.
 */
export async function setSubscriptionCancelled(id: string, cancelled: boolean): Promise<void> {
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  await repo.setCancelled(userId, id, cancelled);
  revalidatePath("/subscriptions");
}

/**
 * Payment-method mutations, scoped to the signed-in user (or demo user). The
 * form's "add new payment method" panel calls `createPaymentMethod` and uses the
 * returned id to set the subscription's `paymentMethodId` on the main submit —
 * so the method exists before the subscription references it.
 */
export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  const userId = await getEffectiveUserId();
  const repo = await getPaymentMethodRepository();
  return repo.list(userId);
}

export async function createPaymentMethod(input: PaymentMethodInput): Promise<PaymentMethod> {
  const parsed = paymentMethodInputSchema.parse(input);
  const userId = await getEffectiveUserId();
  const repo = await getPaymentMethodRepository();
  const created = await repo.create(userId, parsed);
  revalidatePath("/subscriptions");
  return created;
}

export async function updatePaymentMethod(id: string, patch: PaymentMethodPatch): Promise<void> {
  const parsed = paymentMethodPatchSchema.parse(patch);
  const userId = await getEffectiveUserId();
  const repo = await getPaymentMethodRepository();
  await repo.update(userId, id, parsed);
  revalidatePath("/subscriptions");
}

export async function deletePaymentMethod(id: string): Promise<void> {
  const userId = await getEffectiveUserId();
  const repo = await getPaymentMethodRepository();
  await repo.remove(userId, id);
  revalidatePath("/subscriptions");
}

/**
 * Read-only tally of how many subscriptions reference each payment method — the
 * "used by N subscriptions" hint on the settings card. Goes through the
 * subscription repo (not a direct DB count) so it works in mock mode too.
 * Deleting a method is ON DELETE SET NULL, so this counts links, not a hard
 * dependency — it only informs the user before they unlink.
 */
export async function getPaymentMethodUsageCounts(): Promise<Record<string, number>> {
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  const subs = await repo.list(userId);
  const counts: Record<string, number> = {};
  for (const s of subs) {
    if (s.paymentMethodId) {
      counts[s.paymentMethodId] = (counts[s.paymentMethodId] ?? 0) + 1;
    }
  }
  return counts;
}
