import type { Subscription } from "@/types/subscription";
import { getStatus, grossMonthlyCost } from "@/lib/domain/subscription";
import { toMYR } from "@/lib/domain/fx";
import { paymentMethodLabel } from "@/lib/payment-methods";

/**
 * Shared list-sorting dimension for the subscription surfaces (the "All bills"
 * tab and a month's "renewals" list). "date" is intentionally NOT handled by
 * {@link compareSubs} — what "date" means depends on the surface (a month's
 * charge date vs. the next upcoming charge), so each list resolves it before
 * delegating the other keys here.
 */
export type SubscriptionSortKey =
  | "date"
  | "amountDesc"
  | "amountAsc"
  | "name"
  | "provider"
  | "paymentMethod"
  | "status";

export const SUBSCRIPTION_SORT_OPTIONS: ReadonlyArray<{
  value: SubscriptionSortKey;
  label: string;
}> = [
  { value: "date", label: "Date" },
  { value: "amountDesc", label: "Amount: high → low" },
  { value: "amountAsc", label: "Amount: low → high" },
  { value: "name", label: "Name (A–Z)" },
  { value: "provider", label: "Provider (A–Z)" },
  { value: "paymentMethod", label: "Payment method" },
  { value: "status", label: "Status" },
];

/** Status grouping order used by the "status" sort (matches the All-tab sink). */
const STATUS_RANK: Record<string, number> = { active: 0, trial: 1, cancelled: 2 };

/** Recurring monthly cost in the home currency (MYR) — the "amount" sort basis. */
function monthlyMYR(sub: Subscription): number {
  return toMYR(grossMonthlyCost(sub), sub.currency);
}

/**
 * Compare two subscriptions for the non-date sort keys. Returns 0 for "date"
 * (callers handle it). Callers should apply a stable tiebreak (e.g. name) on a
 * 0 result if they need total ordering.
 */
export function compareSubs(
  a: Subscription,
  b: Subscription,
  key: SubscriptionSortKey,
): number {
  switch (key) {
    case "amountDesc":
      return monthlyMYR(b) - monthlyMYR(a);
    case "amountAsc":
      return monthlyMYR(a) - monthlyMYR(b);
    case "name":
      return a.name.localeCompare(b.name);
    case "provider":
      return (a.provider ?? a.name).localeCompare(b.provider ?? b.name);
    case "paymentMethod": {
      // Subs with no payment method sort after every named method.
      const pa = a.paymentMethod
        ? paymentMethodLabel(a.paymentMethod.issuerName, a.paymentMethod.kind)
        : "￿";
      const pb = b.paymentMethod
        ? paymentMethodLabel(b.paymentMethod.issuerName, b.paymentMethod.kind)
        : "￿";
      return pa.localeCompare(pb);
    }
    case "status": {
      const d = STATUS_RANK[getStatus(a)] - STATUS_RANK[getStatus(b)];
      return d !== 0 ? d : (a.nextRenewalAt || "").localeCompare(b.nextRenewalAt || "");
    }
    default:
      return 0;
  }
}
