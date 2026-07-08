import type { BillingCycle } from "@/lib/constants";

const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

/**
 * Fixed locale for currency formatting. Passing `undefined` means "use the
 * runtime default locale", which makes the server (Node) and the browser format
 * the same value differently — e.g. Node's "MYR 40.05" vs a browser's
 * "RM 40.05" — and React flags that as a hydration mismatch on SSR'd totals.
 * en-US gives the familiar symbols ($, RM, €, £, ¥, S$) and is identical on
 * both runtimes.
 */
const CURRENCY_LOCALE = "en-US";

export function formatCurrency(amount: number, currency: string): string {
  const maximumFractionDigits = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE, {
      style: "currency",
      currency,
      maximumFractionDigits,
      minimumFractionDigits: maximumFractionDigits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(maximumFractionDigits)}`;
  }
}

/** Compact currency, e.g. "$1.2k". Falls back to full format under 1,000. */
export function formatCompactCurrency(amount: number, currency: string): string {
  if (Math.abs(amount) < 1000) return formatCurrency(amount, currency);
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(amount);
  } catch {
    return formatCurrency(amount, currency);
  }
}

/** Multiplier that converts one cycle's amount into a per-month figure. */
export function monthlyFactor(cycle: BillingCycle, intervalCount: number): number {
  const n = Math.max(1, intervalCount);
  switch (cycle) {
    case "weekly":
      return 52 / 12;
    case "monthly":
      return 1;
    case "quarterly":
      return 1 / 3;
    case "semiannual":
      return 1 / 6;
    case "annual":
      return 1 / 12;
    case "custom_days":
      return 365 / n / 12;
    case "custom_months":
      return 1 / n;
    case "one_off":
      return 0;
  }
}

export function monthlyEquivalent(
  amount: number,
  cycle: BillingCycle,
  intervalCount: number,
): number {
  return amount * monthlyFactor(cycle, intervalCount);
}

export function yearlyEquivalent(
  amount: number,
  cycle: BillingCycle,
  intervalCount: number,
): number {
  return monthlyEquivalent(amount, cycle, intervalCount) * 12;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
