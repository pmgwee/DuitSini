import type { PaymentKind } from "@/lib/payment-methods";

/**
 * A reusable payment instrument owned by a user — a credit/debit card, an FPX
 * (Malaysian online-banking) account, an e-wallet, or "other". Many
 * subscriptions reference the same method via `Subscription.paymentMethodId`.
 *
 * Deliberately stores NO sensitive card data: no card number, no last 4, no card
 * network. A method is just its kind + the issuing bank/wallet name.
 */
export interface PaymentMethod {
  id: string;
  userId: string;
  kind: PaymentKind;
  /** Catalog slug (PAYMENT_ISSUERS in lib/payment-methods.ts); null for free-text. */
  issuerSlug: string | null;
  /** Denormalized display name (survives a catalog entry being dropped). */
  issuerName: string;
  createdAt: string;
  updatedAt: string;
}
