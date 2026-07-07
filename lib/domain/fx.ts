import { formatCurrency, roundMoney } from "./money";

/**
 * Home currency for the app. It is built for Malaysian users, so every
 * AGGREGATE (totals, monthly/yearly equivalents, charts, dock, reports) is
 * reported in MYR. Individual line items keep their original currency and show
 * an "≈ RM" equivalent beside it.
 */
export const HOME_CURRENCY = "MYR";

/**
 * Approximate exchange rates expressed as **MYR per 1 unit** of each supported
 * currency, i.e. `myrAmount = amount * rate` (MYR itself is 1). These are
 * static, manually-refreshable figures (see RATE_AS_OF) — adequate for a
 * personal budgeting view where every converted figure is already labelled
 * approximate ("≈"). Swapping in a live FX feed later only means replacing this
 * table; every consumer calls `toMYR` and needs no other change.
 *
 * The convention is pinned deliberately: storing MYR-per-1-unit (JPY: 0.028,
 * NOT ~36) keeps `toMYR` a plain multiplication and avoids the classic 30×
 * inversion that would silently make a ¥1,500 charge read as RM 54,000.
 */
export const RATE_AS_OF = "2026-07-01";

const RATES_MYR_PER_UNIT: Record<string, number> = {
  MYR: 1,
  USD: 4.45,
  EUR: 4.8,
  GBP: 5.7,
  SGD: 3.3,
  AUD: 2.95,
  JPY: 0.028,
  INR: 0.052,
};

// Defensive guard: a typo here (e.g. storing the inverse JPY rate ~36) would
// silently corrupt every total, so assert the plausible range at module load.
for (const [code, rate] of Object.entries(RATES_MYR_PER_UNIT)) {
  if (!(rate > 0 && rate < 100)) {
    throw new Error(
      `Invalid FX rate for ${code}: ${rate} (expected MYR-per-1-unit in (0, 100))`,
    );
  }
}

/**
 * Convert an amount in any supported currency into MYR. Unknown / null /
 * undefined currencies are treated as already-MYR (amount returned unchanged,
 * with a one-line warn) so a bad row can never poison an aggregate with NaN.
 */
export function toMYR(amount: number, currency: string | null | undefined): number {
  if (!Number.isFinite(amount)) return 0;
  if (currency == null || currency === HOME_CURRENCY) return amount;
  const rate = RATES_MYR_PER_UNIT[currency];
  if (rate == null) {
    if (typeof console !== "undefined" && "warn" in console) {
      console.warn(`[fx] No MYR rate for currency "${currency}"; treating as MYR.`);
    }
    return amount;
  }
  return amount * rate;
}

/** Format an MYR amount with the ringgit symbol (e.g. "RM 39.90"). */
export function formatMYR(amount: number): string {
  return formatCurrency(amount, HOME_CURRENCY);
}

/**
 * The MYR equivalent of a foreign amount as a display string, or `null` when
 * the amount is already in MYR — so callers can skip rendering the "≈" hint
 * for ringgit amounts. Rounded independently of any aggregate sum.
 */
export function myrEquivalentOf(
  amount: number,
  currency: string | null | undefined,
): string | null {
  if (currency == null || currency === HOME_CURRENCY) return null;
  return formatMYR(roundMoney(toMYR(amount, currency)));
}
