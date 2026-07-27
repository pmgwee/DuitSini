import type { PaymentMethod } from "@/types/payment-method";
import { seedPaymentMethods } from "./seed";

/**
 * Shared in-memory payment-method store (module-level singleton, lives for the
 * dev server process). Imported by BOTH the mock payment-method repo and the
 * mock subscription repo — the latter resolves a subscription's method from it
 * — so a method created by one is visible to the other within a request.
 */
export const paymentMethodStore = new Map<string, PaymentMethod>();
for (const m of seedPaymentMethods()) paymentMethodStore.set(m.id, m);
