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

// Empty strings arrive from unchecked checkboxes, unmounted inputs, and
// cleared text fields — react-hook-form's `setValueAs` only fires on a field's
// own onChange, never on defaultValues, so an untouched "" reaches the resolver
// verbatim. We normalize "" → null (NOT undefined) here, which fixes three real
// problems at once:
//   1. `freeTrialEndAt` defaulted to "" previously failed the ISO-date regex
//      and silently blocked saving ANY non-trial subscription (the error's
//      field isn't even rendered when the trial box is unchecked). null passes
//      `.nullish()` so submit proceeds.
//   2. A cleared nullable text field now round-trips to `null` in storage
//      instead of "" — so an unrelated edit can't rewrite existing nulls to
//      empty strings.
//   3. Crucially, `applySubscriptionPatch` treats `undefined` as "leave
//      untouched" (`if (patch.x !== undefined)`), so "" → undefined would make
//      CLEARING a field a silent no-op. null is a real "clear this" signal that
//      the patch applier stores via its existing `?? null` coercion.
const optionalDate = z.preprocess(
  (v) => (v === "" || v == null ? null : v),
  z.string().regex(ISO_DATE, "Invalid date").nullish(),
);
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (v === "" || v == null ? null : v),
    z.string().trim().max(max).nullish(),
  );

/** Raw field definitions, shared by the create and patch schemas. */
export const subscriptionFieldsSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  provider: optionalText(80),
  category: z.enum(CATEGORIES),
  amount: z.number().nonnegative("Amount can't be negative").max(1_000_000),
  currency: z.enum(CURRENCIES),
  billingCycle: z.enum(BILLING_CYCLES),
  intervalCount: z.number().int().min(1).max(365).default(1),
  planType: optionalText(60),
  startDate: z.string().regex(ISO_DATE, "Invalid date"),
  freeTrialEndAt: optionalDate,
  isTrial: z.boolean().default(false),
  unsubscribeUrl: optionalText(300),
  color: optionalText(32),
  notes: optionalText(500),
  reminderOffsetsDays: z.array(z.number().int().min(0).max(60)).max(6).nullish(),
  reminderTimeLocal: z.string().regex(HH_MM, "Use HH:mm").default("09:00"),
  // telegram is included by default so reminders "just work" once a member
  // connects Telegram — delivery is still gated per-user by telegram_enabled +
  // a linked chat_id, so this can never message anyone who hasn't opted in.
  notificationChannels: z.array(notificationChannelSchema).default(["telegram", "in_app"]),
});

// Payment method: required when creating a subscription; optional + clearable
// (null) when editing, so backfilled subs can remain "unspecified" until the
// user picks one. The empty-string form value is normalized to null on the
// patch path, mirroring the "" → null rule above.
const paymentMethodIdRequired = z.string().trim().min(1, "Pick a payment method");
const paymentMethodIdOptional = z.preprocess(
  (v) => (v === "" || v == null ? null : v),
  z.string().trim().min(1, "Pick a payment method").nullish(),
);

/** Create: full object with trial cross-field checks. */
export const subscriptionInputSchema = subscriptionFieldsSchema
  .extend({ paymentMethodId: paymentMethodIdRequired })
  .refine((data) => !data.isTrial || Boolean(data.freeTrialEndAt), {
    message: "Trial subscriptions need a trial end date",
    path: ["freeTrialEndAt"],
  })
  .refine((data) => !data.isTrial || !data.freeTrialEndAt || data.freeTrialEndAt >= data.startDate, {
    message: "Trial end must be on or after the start date",
    path: ["freeTrialEndAt"],
  });

/** Patch: every field optional; absent keys stay untouched (no defaults applied).
 * Carries the same trial cross-field checks as create, scoped to partials. */
export const subscriptionPatchSchema = subscriptionFieldsSchema
  .partial()
  .extend({ paymentMethodId: paymentMethodIdOptional })
  .refine((data) => data.isTrial !== true || Boolean(data.freeTrialEndAt), {
    message: "Trial subscriptions need a trial end date",
    path: ["freeTrialEndAt"],
  })
  .refine(
    (data) =>
      !(data.isTrial && data.freeTrialEndAt && data.startDate) ||
      data.freeTrialEndAt >= data.startDate,
    { message: "Trial end must be on or after the start date", path: ["freeTrialEndAt"] },
  );

export type SubscriptionInput = z.infer<typeof subscriptionInputSchema>;
export type SubscriptionPatch = z.infer<typeof subscriptionPatchSchema>;
