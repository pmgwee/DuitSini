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

export async function setSubscriptionPaused(id: string, paused: boolean): Promise<void> {
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  await repo.setPaused(userId, id, paused);
  revalidatePath("/subscriptions");
}

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
