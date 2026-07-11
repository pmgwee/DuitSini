/**
 * Versioned snapshot schemas for stored reports.
 *
 * A report is a STATEMENT: it describes a closed period, is generated once, and
 * is stored immutably. The report page renders from `totals_json` (the snapshot)
 * and never recomputes history — so deleting a subscription later can't silently
 * rewrite a past statement. `v` lets a future schema change coexist with rows
 * written under the old shape (the page narrows on `v === 1`).
 *
 * EVERY monetary figure is in the home currency (MYR), converted per-line at full
 * precision and rounded once per stored figure (CLAUDE.md money rule).
 */

/** Snapshot version. Bump + add a V2 type alongside when the shape changes. */
export const REPORT_TOTALS_VERSION = 1 as const;

/** A single charge that landed in the period ("statement line"). */
export interface ReportChargeLine {
  /** Civil charge date (YYYY-MM-DD). */
  dateISO: string;
  name: string;
  /** Original amount in its native currency (major units). */
  amount: number;
  currency: string;
  /** MYR equivalent (full precision, unrounded — rounded only when displayed). */
  amountMYR: number;
  category: string;
  /** True when this charge date equals the sub's trial-end (first paid charge). */
  isTrialConversion: boolean;
}

/** A category's contribution to the period's spend. */
export interface ReportCategoryTotal {
  category: string;
  label: string;
  /** MYR, rounded once. */
  totalMYR: number;
}

/** A charge expected in the forward-look window. */
export interface ReportUpcomingLine {
  dateISO: string;
  name: string;
  /** MYR, rounded once. */
  amountMYR: number;
}

/** A trial converting to paid in the forward-look window. */
export interface ReportTrialConversion {
  name: string;
  dateISO: string;
  /** Original amount (major units) for display. */
  amount: number;
  currency: string;
  /** MYR, rounded once. */
  amountMYR: number;
}

/**
 * Monthly statement snapshot. Stored as `monthly_reports.totals_json`.
 */
export interface MonthlyReportTotalsV1 {
  v: typeof REPORT_TOTALS_VERSION;
  /** Covered month, e.g. "2026-06". */
  monthKey: string;
  /** Civil date the snapshot was generated. */
  generatedOnISO: string;

  // § Spend summary
  /** Sum of charges that LANDED in the month (the "this month actual" figure). */
  totalMYR: number;
  /** Same computation over the prior month (for the MoM delta). */
  prevMonthTotalMYR: number;
  /** (curr − prev) / prev × 100; null when prev == 0 (no div-by-zero). */
  deltaPct: number | null;
  /** Active subscription count at generation time. */
  activeCount: number;
  /** Normalized /mo figure (the OTHER usage number — smoothed across cycles). */
  recurringMonthlyMYR: number;

  // § Category breakdown (only categories with spend, sorted desc)
  categories: ReportCategoryTotal[];

  // § Itemized charges (statement lines, sorted by date)
  charges: ReportChargeLine[];

  // § Forward look (the month AFTER the covered one — when the report lands)
  upcoming: ReportUpcomingLine[];
  upcomingTotalMYR: number;
  trialsConverting: ReportTrialConversion[];
  /** Σ grossMonthlyCost of cancelled subs (the would-be monthly spend saved). */
  cancellationSavingsMYR: number;
  /** Annualized savings (×12 from full precision, rounded once) — avoids the
   *  double-round of roundMoney(monthly × 12) and agrees with the yearly report. */
  cancellationSavingsYearlyMYR: number;
}

/** A month bucket in the yearly statement (12 entries, Jan..Dec). */
export interface ReportYearlyMonthBucket {
  monthKey: string;
  /** MYR, rounded once. */
  totalMYR: number;
}

/** A subscription's year-to-date spend (for the "top subscriptions" list). */
export interface ReportTopSubscription {
  name: string;
  /** MYR, rounded once. */
  totalMYR: number;
}

/**
 * Yearly statement snapshot. Stored as `yearly_reports.totals_json`. A thin
 * variant of the monthly builder: the same charge-engine math, aggregated over
 * twelve months instead of one.
 */
export interface YearlyReportTotalsV1 {
  v: typeof REPORT_TOTALS_VERSION;
  /** Covered year, e.g. "2025". */
  yearKey: string;
  generatedOnISO: string;

  totalMYR: number;
  prevYearTotalMYR: number;
  deltaPct: number | null;

  /** 12 entries (Jan..Dec), each the month's landed charges in MYR. */
  monthlyBuckets: ReportYearlyMonthBucket[];
  categories: ReportCategoryTotal[];
  /** Top 5 subscriptions by year spend. */
  topSubscriptions: ReportTopSubscription[];
  /** Annualized would-be spend of cancelled subs (grossMonthlyCost × 12). */
  cancellationSavingsMYR: number;
}

/** The variant the page renders, discriminated by version. */
export type AnyReportTotals = MonthlyReportTotalsV1 | YearlyReportTotalsV1;

/** A `delivered_channels_json` entry on a report row. */
export interface ReportDeliveryChannel {
  channel: "telegram";
  /** ISO timestamp of the delivery attempt. */
  at: string;
  status: "sent" | "failed" | "skipped";
}
