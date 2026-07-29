import type { Subscription } from "@/types/subscription";
import type { PaymentMethod } from "@/types/payment-method";
import type { SubscriptionInput, SubscriptionPatch } from "@/lib/validation/subscription";
import type { PaymentMethodInput, PaymentMethodPatch } from "@/lib/validation/payment-method";

/** Fixed identity used by the mock data source before auth is wired up. */
export const DEMO_USER_ID = "demo-user";

export interface SubscriptionRepository {
  list(userId: string): Promise<Subscription[]>;
  get(userId: string, id: string): Promise<Subscription | null>;
  create(userId: string, input: SubscriptionInput): Promise<Subscription>;
  update(userId: string, id: string, patch: SubscriptionPatch): Promise<Subscription | null>;
  remove(userId: string, id: string): Promise<boolean>;
  setCancelled(userId: string, id: string, cancelled: boolean): Promise<Subscription | null>;
}

export interface PaymentMethodRepository {
  list(userId: string): Promise<PaymentMethod[]>;
  create(userId: string, input: PaymentMethodInput): Promise<PaymentMethod>;
  update(userId: string, id: string, patch: PaymentMethodPatch): Promise<PaymentMethod | null>;
  remove(userId: string, id: string): Promise<boolean>;
}
