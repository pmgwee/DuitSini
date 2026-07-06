import type { Subscription } from "@/types/subscription";
import type { SubscriptionInput, SubscriptionPatch } from "@/lib/validation/subscription";

/** Fixed identity used by the mock data source before auth is wired up. */
export const DEMO_USER_ID = "demo-user";

export interface SubscriptionRepository {
  list(userId: string): Promise<Subscription[]>;
  get(userId: string, id: string): Promise<Subscription | null>;
  create(userId: string, input: SubscriptionInput): Promise<Subscription>;
  update(userId: string, id: string, patch: SubscriptionPatch): Promise<Subscription | null>;
  remove(userId: string, id: string): Promise<boolean>;
  setPaused(userId: string, id: string, paused: boolean): Promise<Subscription | null>;
  setCancelled(userId: string, id: string, cancelled: boolean): Promise<Subscription | null>;
}
