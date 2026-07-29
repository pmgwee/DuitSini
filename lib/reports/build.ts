/**
 * Pure report builders — the statement-generation core.
 *
 * PURE: no I/O and no clock reads. The caller passes the subscription list and
 * the civil `generatedOnISO` (already resolved into the user's timezone by the
 * route). Everything else — which charges landed, the MoM/YoY delta, the forward
 * look, category totals — is derived deterministically from the existing charge
 * engine (`lib/domain/`), the same math the calendar and the statistics tab use.
 *
 * Money rule (CLAUDE.md): each charge is converted to MYR at full precision,
 * summed, and `roundMoney`-d ONCE per stored figure. Line items keep their
 * native `amount`/`currency` alongside the MYR equivalent.
 *
 * Delta: the previous period is recomputed with the SAME builder logic over the
 * current subscription list — it never reads a prior stored report (so the first
 * report still gets a delta, and a missing prior row can't corrupt the math).
 */
import type { Subscription } from "@/types/subscription";
import type { Category } from "@/lib/constants";
import { CATEGORY_META } from "@/lib/constants";
import {
  chargeDatesInRange,
  chargesTotalMYRInRange,
  grossMonthlyCost,
  isActive,
  isCancelled,
  monthlyAmount,
} from "@/lib/domain/subscription";
import { toMYR } from "@/lib/domain/fx";
import { roundMoney } from "@/lib/domain/money";
import type {
  MonthlyReportTotalsV1,
  ReportCategoryTotal,
  ReportChargeLine,
  ReportTopSubscription,
  ReportTrialConversion,
  ReportUpcomingLine,
  YearlyReportTotalsV1,
} from "./types";
import { REPORT_TOTALS_VERSION } from "./types";
import {
  monthKeyBounds,
  nextMonthKey,
  prevMonthKey,
  prevYearKey,
  yearKeyBounds,
} from "./period";

/** (curr − prev) / prev × 100, rounded to 2dp; null when prev == 0. */
function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return roundMoney(((curr - prev) / prev) * 100);
}

/**
 * Build the statement lines for every charge landing in [startISO, endISO]:
 * date, name, native amount + MYR equivalent, category, trial-conversion flag.
 * Sorted by date then name (stable). A cancelled sub still contributes charges
 * dated before its `cancelledAt` cutoff (its paid history stays on the books).
 */
function collectChargeLines(
  subs: Subscription[],
  startISO: string,
  endISO: string,
): ReportChargeLine[] {
  const lines: ReportChargeLine[] = [];
  for (const sub of subs) {
    // No `isActive` gate here: `chargeDatesInRange` already drops a cancelled
    // sub's on/after-cutoff charges, so past statements keep what was paid.
    const dates = chargeDatesInRange(sub, startISO, endISO);
    for (const dateISO of dates) {
      lines.push({
        dateISO,
        name: sub.name,
        amount: sub.amount,
        currency: sub.currency,
        amountMYR: toMYR(sub.amount, sub.currency),
        category: sub.category,
        isTrialConversion: sub.isTrial && sub.freeTrialEndAt === dateISO,
      });
    }
  }
  lines.sort((a, b) =>
    a.dateISO === b.dateISO ? a.name.localeCompare(b.name) : a.dateISO.localeCompare(b.dateISO),
  );
  return lines;
}

/**
 * Aggregate statement lines into per-category MYR totals — only categories with
 * spend, sorted descending. Each category's total is summed at full precision
 * and rounded once.
 */
function aggregateCategories(lines: ReportChargeLine[]): ReportCategoryTotal[] {
  const sums = new Map<string, number>();
  for (const l of lines) {
    sums.set(l.category, (sums.get(l.category) ?? 0) + l.amountMYR);
  }
  return [...sums.entries()]
    .map(([category, total]) => ({
      category,
      label: CATEGORY_META[category as Category]?.label ?? category,
      totalMYR: roundMoney(total),
    }))
    .sort((a, b) => b.totalMYR - a.totalMYR);
}

/** Cancellation savings: Σ grossMonthlyCost (ignores cancel state) of cancelled subs. */
function cancelledSavingsMYR(subs: Subscription[], annualized: boolean): number {
  const factor = annualized ? 12 : 1;
  return roundMoney(
    subs
      .filter(isCancelled)
      .reduce((sum, sub) => sum + toMYR(grossMonthlyCost(sub) * factor, sub.currency), 0),
  );
}

/**
 * Build a monthly statement snapshot for `monthKey`. The caller passes the user's
 * current subscriptions and the civil date of generation. Pure.
 */
export function buildMonthlyReport(
  subs: Subscription[],
  monthKey: string,
  generatedOnISO: string,
): MonthlyReportTotalsV1 {
  const { startISO, endISO } = monthKeyBounds(monthKey);
  const active = subs.filter(isActive);

  const charges = collectChargeLines(subs, startISO, endISO);
  const totalMYR = chargesTotalMYRInRange(subs, startISO, endISO);
  const prev = monthKeyBounds(prevMonthKey(monthKey));
  const prevMonthTotalMYR = chargesTotalMYRInRange(subs, prev.startISO, prev.endISO);

  const recurringMonthlyMYR = roundMoney(
    active.reduce((sum, sub) => sum + toMYR(monthlyAmount(sub), sub.currency), 0),
  );

  // Forward look: the month AFTER the covered one (the month the report lands in).
  const fwd = monthKeyBounds(nextMonthKey(monthKey));
  const upcoming: ReportUpcomingLine[] = [];
  const trialsConverting: ReportTrialConversion[] = [];
  for (const sub of active) {
    const dates = chargeDatesInRange(sub, fwd.startISO, fwd.endISO);
    for (const dateISO of dates) {
      upcoming.push({ dateISO, name: sub.name, amountMYR: toMYR(sub.amount, sub.currency) });
    }
    if (sub.isTrial && sub.freeTrialEndAt && sub.freeTrialEndAt >= fwd.startISO && sub.freeTrialEndAt <= fwd.endISO) {
      trialsConverting.push({
        name: sub.name,
        dateISO: sub.freeTrialEndAt,
        amount: sub.amount,
        currency: sub.currency,
        amountMYR: roundMoney(toMYR(sub.amount, sub.currency)),
      });
    }
  }
  upcoming.sort((a, b) =>
    a.dateISO === b.dateISO ? a.name.localeCompare(b.name) : a.dateISO.localeCompare(b.dateISO),
  );
  trialsConverting.sort((a, b) => a.dateISO.localeCompare(b.dateISO));

  return {
    v: REPORT_TOTALS_VERSION,
    monthKey,
    generatedOnISO,
    totalMYR,
    prevMonthTotalMYR,
    deltaPct: deltaPct(totalMYR, prevMonthTotalMYR),
    activeCount: active.length,
    recurringMonthlyMYR,
    categories: aggregateCategories(charges),
    charges,
    upcoming,
    upcomingTotalMYR: roundMoney(upcoming.reduce((s, u) => s + u.amountMYR, 0)),
    trialsConverting,
    cancellationSavingsMYR: cancelledSavingsMYR(subs, false),
    cancellationSavingsYearlyMYR: cancelledSavingsMYR(subs, true),
  };
}

/**
 * Build a yearly statement snapshot for `yearKey`. A thin variant of the monthly
 * builder: the same charge-engine math aggregated over twelve months.
 */
export function buildYearlyReport(
  subs: Subscription[],
  yearKey: string,
  generatedOnISO: string,
): YearlyReportTotalsV1 {
  const { startISO, endISO } = yearKeyBounds(yearKey);
  const active = subs.filter(isActive);

  const totalMYR = chargesTotalMYRInRange(subs, startISO, endISO);
  const prev = yearKeyBounds(prevYearKey(yearKey));
  const prevYearTotalMYR = chargesTotalMYRInRange(subs, prev.startISO, prev.endISO);

  // 12 monthly buckets (Jan..Dec), each the month's landed-charges MYR total.
  const year = Number(yearKey);
  const monthlyBuckets = Array.from({ length: 12 }, (_, m0) => {
    const b = monthKeyBounds(`${year}-${String(m0 + 1).padStart(2, "0")}`);
    return {
      monthKey: `${year}-${String(m0 + 1).padStart(2, "0")}`,
      totalMYR: chargesTotalMYRInRange(subs, b.startISO, b.endISO),
    };
  });

  const charges = collectChargeLines(subs, startISO, endISO);
  const categories = aggregateCategories(charges);

  // Top 5 subscriptions by year spend (MYR), ranked on MYR value so a ¥ sub
  // doesn't outrank a € one.
  const topSubscriptions: ReportTopSubscription[] = active
    .map((sub) => {
      const count = chargeDatesInRange(sub, startISO, endISO).length;
      return { name: sub.name, totalMYR: roundMoney(count * toMYR(sub.amount, sub.currency)) };
    })
    .filter((s) => s.totalMYR > 0)
    .sort((a, b) => b.totalMYR - a.totalMYR)
    .slice(0, 5);

  return {
    v: REPORT_TOTALS_VERSION,
    yearKey,
    generatedOnISO,
    totalMYR,
    prevYearTotalMYR,
    deltaPct: deltaPct(totalMYR, prevYearTotalMYR),
    monthlyBuckets,
    categories,
    topSubscriptions,
    cancellationSavingsMYR: cancelledSavingsMYR(subs, true),
  };
}
