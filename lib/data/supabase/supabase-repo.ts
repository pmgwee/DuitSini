import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingCycle, Category, CurrencyCode } from "@/lib/constants";
import type { Database } from "@/lib/supabase/types";
import type { IconType, NotificationChannel, Subscription } from "@/types/subscription";
import type { SubscriptionInput, SubscriptionPatch } from "@/lib/validation/subscription";
import {
  applySubscriptionPatch,
  computeNextRenewalInstant,
} from "@/lib/domain/subscription";
import type { SubscriptionRepository } from "../types";
import { rowToPaymentMethod } from "./payment-method-repo";

type Row = Database["public"]["Tables"]["subscriptions"]["Row"];
type Insert = Database["public"]["Tables"]["subscriptions"]["Insert"];
type UpdateRow = Database["public"]["Tables"]["subscriptions"]["Update"];

/** A subscriptions row plus the optional nested payment_method from a join. */
type SubRow = Row & {
  payment_method?: Database["public"]["Tables"]["payment_methods"]["Row"] | null;
};

/** Selects the subscription row with its payment method joined in one round-trip. */
const WITH_METHOD = "*, payment_method:payment_methods(*)";

/**
 * Map a raw subscriptions row (snake_case) to the domain `Subscription`
 * (camelCase). Accepts an optional joined `payment_method` (resolved when the
 * row came from a `WITH_METHOD` select); plain `*` selects pass `Row`, which is
 * assignable (the join key is optional) — so the cron sweep and other `*`
 * callers keep compiling unchanged. Exported so the cron sweep — which reads
 * rows with the service-role client across all users — reuses the SAME mapping.
 */
export function rowToSubscription(row: SubRow): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    provider: row.provider,
    category: row.category as Category,
    amount: Number(row.amount),
    currency: row.currency as CurrencyCode,
    billingCycle: row.billing_cycle as BillingCycle,
    intervalCount: row.interval_count,
    planType: row.plan_type,
    startDate: row.start_date,
    nextRenewalAt: row.next_renewal_at ?? `${row.start_date}T09:00:00.000Z`,
    freeTrialEndAt: row.free_trial_end_at,
    isTrial: row.is_trial,
    isPaused: row.is_paused,
    isCancelled: row.is_cancelled,
    unsubscribeUrl: row.unsubscribe_url,
    iconType: (row.icon_type as IconType) ?? "monogram",
    iconUrl: row.icon_url,
    color: row.color,
    notes: row.notes,
    reminderOffsetsDays: row.reminder_offsets_days,
    reminderTimeLocal: row.reminder_time_local,
    notificationChannels: (row.notification_channels ?? []) as NotificationChannel[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paymentMethodId: row.payment_method_id ?? null,
    paymentMethod: row.payment_method ? rowToPaymentMethod(row.payment_method) : null,
  };
}

/** Mutable columns only — id/user_id/timestamps are managed elsewhere. */
function subscriptionToColumns(sub: Subscription): UpdateRow {
  return {
    name: sub.name,
    provider: sub.provider,
    category: sub.category,
    amount: sub.amount,
    currency: sub.currency,
    billing_cycle: sub.billingCycle,
    interval_count: sub.intervalCount,
    plan_type: sub.planType,
    start_date: sub.startDate,
    next_renewal_at: sub.nextRenewalAt,
    free_trial_end_at: sub.freeTrialEndAt,
    is_trial: sub.isTrial,
    is_paused: sub.isPaused,
    is_cancelled: sub.isCancelled,
    unsubscribe_url: sub.unsubscribeUrl,
    icon_type: sub.iconType,
    icon_url: sub.iconUrl,
    color: sub.color,
    notes: sub.notes,
    reminder_offsets_days: sub.reminderOffsetsDays,
    reminder_time_local: sub.reminderTimeLocal,
    notification_channels: sub.notificationChannels,
    payment_method_id: sub.paymentMethodId,
  };
}

/**
 * Supabase-backed repository. RLS enforces ownership; we additionally filter by
 * user_id as defense in depth. Requires an authenticated server client.
 */
export function createSupabaseSubscriptionRepository(
  client: SupabaseClient<Database>,
): SubscriptionRepository {
  const table = () => client.from("subscriptions");

  return {
    async list(userId) {
      const { data, error } = await table()
        .select(WITH_METHOD)
        .eq("user_id", userId)
        .order("next_renewal_at", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as unknown as SubRow[]).map(rowToSubscription);
    },

    async get(userId, id) {
      const { data, error } = await table()
        .select(WITH_METHOD)
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToSubscription(data as unknown as SubRow) : null;
    },

    async create(userId, input: SubscriptionInput) {
      const nextRenewalAt = computeNextRenewalInstant({
        startDate: input.startDate,
        isTrial: input.isTrial,
        freeTrialEndAt: input.freeTrialEndAt ?? null,
        billingCycle: input.billingCycle,
        intervalCount: input.intervalCount,
        reminderTimeLocal: input.reminderTimeLocal,
      });
      const insert: Insert = {
        user_id: userId,
        name: input.name,
        provider: input.provider ?? input.name,
        category: input.category,
        amount: input.amount,
        currency: input.currency,
        billing_cycle: input.billingCycle,
        interval_count: input.intervalCount,
        plan_type: input.planType ?? null,
        start_date: input.startDate,
        next_renewal_at: nextRenewalAt,
        free_trial_end_at: input.freeTrialEndAt ?? null,
        is_trial: input.isTrial,
        is_paused: false,
        is_cancelled: false,
        unsubscribe_url: input.unsubscribeUrl ? input.unsubscribeUrl : null,
        icon_type: "monogram",
        color: input.color ?? null,
        notes: input.notes ?? null,
        reminder_offsets_days: input.reminderOffsetsDays ?? null,
        reminder_time_local: input.reminderTimeLocal,
        notification_channels: input.notificationChannels,
        payment_method_id: input.paymentMethodId,
      };
      const { data, error } = await table().insert(insert).select(WITH_METHOD).single();
      if (error) throw error;
      return rowToSubscription(data as unknown as SubRow);
    },

    async update(userId, id, patch: SubscriptionPatch) {
      const { data: existing, error: fetchError } = await table()
        .select(WITH_METHOD)
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();
      if (fetchError) throw fetchError;
      if (!existing) return null;

      const merged = rowToSubscription(existing as unknown as SubRow);
      applySubscriptionPatch(merged, patch);
      merged.nextRenewalAt = computeNextRenewalInstant(merged);

      const { data, error } = await table()
        .update(subscriptionToColumns(merged))
        .eq("id", id)
        .eq("user_id", userId)
        .select(WITH_METHOD)
        .single();
      if (error) throw error;
      return rowToSubscription(data as unknown as SubRow);
    },

    async remove(userId, id) {
      const { data, error } = await table()
        .delete()
        .eq("id", id)
        .eq("user_id", userId)
        .select("id");
      if (error) throw error;
      return (data?.length ?? 0) > 0;
    },

    async setPaused(userId, id, paused) {
      const { data, error } = await table()
        .update({ is_paused: paused })
        .eq("id", id)
        .eq("user_id", userId)
        .select(WITH_METHOD)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToSubscription(data as unknown as SubRow) : null;
    },

    async setCancelled(userId, id, cancelled) {
      const { data, error } = await table()
        .update({ is_cancelled: cancelled })
        .eq("id", id)
        .eq("user_id", userId)
        .select(WITH_METHOD)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToSubscription(data as unknown as SubRow) : null;
    },
  };
}
