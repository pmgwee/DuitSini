/**
 * Civil-date helpers. Subscription charge dates are calendar dates (not
 * instants), so we deliberately parse/format them in a timezone-stable way to
 * avoid the classic off-by-one that happens when `new Date("YYYY-MM-DD")` is
 * interpreted as UTC midnight and then shifted into a local timezone.
 */

/** Format a Date as a civil ISO date string (YYYY-MM-DD) using local fields. */
export function toISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse a civil ISO date string (YYYY-MM-DD) into a local-midnight Date. */
export function parseISODate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

/** Whole days from `from` (00:00) until the given civil date. Negative = past. */
export function daysUntil(value: string, from: Date = new Date()): number {
  const target = parseISODate(value).getTime();
  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  return Math.round((target - base) / 86_400_000);
}

/**
 * Fixed locale for all date formatting. Passing `undefined` means "use the
 * runtime default locale", which makes the server (Node) and the browser format
 * the same date differently — e.g. Node's "29 Jun 2026" vs a US browser's
 * "Jun 29, 2026" — and React flags that as a hydration mismatch (the calendar
 * cells render `formatLongDate` into their aria-label during SSR). en-GB gives
 * day-first dates (29 Jun 2026), matching the Malaysian convention.
 */
const DATE_LOCALE = "en-GB";

export function formatShortDate(value: string): string {
  return parseISODate(value).toLocaleDateString(DATE_LOCALE, {
    day: "numeric",
    month: "short",
  });
}

export function formatLongDate(value: string): string {
  return parseISODate(value).toLocaleDateString(DATE_LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatMonthYear(date: Date): string {
  return date.toLocaleDateString(DATE_LOCALE, { month: "long", year: "numeric" });
}

/** Relative phrasing for a civil date, e.g. "in 3 days", "today", "2 days ago". */
export function formatRelativeDay(value: string, from: Date = new Date()): string {
  const days = daysUntil(value, from);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 0) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}
