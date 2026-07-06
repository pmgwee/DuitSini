import { addDays, addMonths, addWeeks } from "date-fns";
import type { BillingCycle } from "@/lib/constants";
import { parseISODate, toISODate } from "./dates";

// Safety bound so a very old anchor with a short cycle can never loop forever.
const MAX_STEPS = 6000;

/** Advance a date by exactly one billing period. */
export function stepDate(date: Date, cycle: BillingCycle, intervalCount: number): Date {
  const n = Math.max(1, intervalCount);
  switch (cycle) {
    case "weekly":
      return addWeeks(date, 1);
    case "monthly":
      return addMonths(date, 1);
    case "quarterly":
      return addMonths(date, 3);
    case "semiannual":
      return addMonths(date, 6);
    case "annual":
      return addMonths(date, 12);
    case "custom_days":
      return addDays(date, n);
    case "custom_months":
      return addMonths(date, n);
    case "one_off":
      return date;
  }
}

/**
 * The first charge date on or after `fromISO`, given an anchor date and cycle.
 * Returns null for a one-off whose single date is already in the past.
 */
export function nextChargeOnOrAfter(
  anchorISO: string,
  cycle: BillingCycle,
  intervalCount: number,
  fromISO: string,
): string | null {
  const from = parseISODate(fromISO).getTime();
  let current = parseISODate(anchorISO);

  if (cycle === "one_off") {
    return current.getTime() >= from ? toISODate(current) : null;
  }

  let steps = 0;
  while (current.getTime() < from && steps < MAX_STEPS) {
    current = stepDate(current, cycle, intervalCount);
    steps += 1;
  }
  return toISODate(current);
}

/**
 * All charge dates within the inclusive civil-date range [startISO, endISO].
 * Used to render calendar months and 30-day windows.
 */
export function chargesInRange(
  anchorISO: string,
  cycle: BillingCycle,
  intervalCount: number,
  startISO: string,
  endISO: string,
): string[] {
  const start = parseISODate(startISO).getTime();
  const end = parseISODate(endISO).getTime();
  const dates: string[] = [];

  if (cycle === "one_off") {
    const single = parseISODate(anchorISO).getTime();
    if (single >= start && single <= end) dates.push(toISODate(parseISODate(anchorISO)));
    return dates;
  }

  let current = parseISODate(anchorISO);
  let steps = 0;
  while (current.getTime() < start && steps < MAX_STEPS) {
    current = stepDate(current, cycle, intervalCount);
    steps += 1;
  }
  while (current.getTime() <= end && steps < MAX_STEPS) {
    dates.push(toISODate(current));
    current = stepDate(current, cycle, intervalCount);
    steps += 1;
  }
  return dates;
}
