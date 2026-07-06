import { z } from "zod";
import { BILLING_CYCLES, CATEGORIES, CURRENCIES } from "@/lib/constants";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{2}:\d{2}$/;

export const notificationChannelSchema = z.enum([
  "telegram",
  "whatsapp",
  "email",
  "in_app",
]);

/** Raw field definitions, shared by the create and patch schemas. */
export const subscriptionFieldsSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  provider: z.string().trim().max(80).nullish(),
  category: z.enum(CATEGORIES),
  amount: z.number().nonnegative("Amount can't be negative").max(1_000_000),
  currency: z.enum(CURRENCIES),
  billingCycle: z.enum(BILLING_CYCLES),
  intervalCount: z.number().int().min(1).max(365).default(1),
  planType: z.string().trim().max(60).nullish(),
  startDate: z.string().regex(ISO_DATE, "Invalid date"),
  freeTrialEndAt: z.string().regex(ISO_DATE, "Invalid date").nullish(),
  isTrial: z.boolean().default(false),
  unsubscribeUrl: z.string().trim().max(300).nullish(),
  color: z.string().trim().max(32).nullish(),
  notes: z.string().trim().max(500).nullish(),
  reminderOffsetsDays: z.array(z.number().int().min(0).max(60)).max(6).default([7, 3, 1]),
  reminderTimeLocal: z.string().regex(HH_MM, "Use HH:mm").default("09:00"),
  notificationChannels: z.array(notificationChannelSchema).default(["in_app"]),
});

/** Create: full object with a trial cross-field check. */
export const subscriptionInputSchema = subscriptionFieldsSchema.refine(
  (data) => !data.isTrial || Boolean(data.freeTrialEndAt),
  { message: "Trial subscriptions need a trial end date", path: ["freeTrialEndAt"] },
);

/** Patch: every field optional; absent keys stay untouched (no defaults applied).
 * Carries the same trial cross-field check as create, scoped to partials. */
export const subscriptionPatchSchema = subscriptionFieldsSchema
  .partial()
  .refine((data) => data.isTrial !== true || Boolean(data.freeTrialEndAt), {
    message: "Trial subscriptions need a trial end date",
    path: ["freeTrialEndAt"],
  });

export type SubscriptionInput = z.infer<typeof subscriptionInputSchema>;
export type SubscriptionPatch = z.infer<typeof subscriptionPatchSchema>;
