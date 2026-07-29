import { z } from "zod";
import { PAYMENT_KINDS } from "@/lib/payment-methods";

// Mirrors the "" → null normalization used by subscription validation so a
// cleared text field round-trips to null instead of "".
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (v === "" || v == null ? null : v),
    z.string().trim().max(max).nullish(),
  );

/** Raw field definitions, shared by the create and patch schemas. */
export const paymentMethodFieldsSchema = z.object({
  kind: z.enum(PAYMENT_KINDS),
  issuerSlug: optionalText(80),
  issuerName: z.string().trim().min(1, "Issuer name is required").max(80),
});

/** Create: full field object. No card number or nickname is collected. */
export const paymentMethodInputSchema = paymentMethodFieldsSchema;

/** Patch: every field optional; absent keys stay untouched. */
export const paymentMethodPatchSchema = paymentMethodFieldsSchema.partial();

export type PaymentMethodInput = z.infer<typeof paymentMethodInputSchema>;
export type PaymentMethodPatch = z.infer<typeof paymentMethodPatchSchema>;
