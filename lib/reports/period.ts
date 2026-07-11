/**
 * Period / key helpers for the reports feature — pure, framework-agnostic, and
 * clock-free except for `todayISOFor`, which converts a wall-clock instant into a
 * civil date for a given timezone (the caller decides *when* to call it).
 *
 * All date math uses civil dates (YYYY-MM-DD) parsed via `parseISODate` /
 * formatted via `toISODate` (see CLAUDE.md): never `new Date("YYYY-MM-DD")`,
 * which would be read as UTC-midnight and shift a day in non-UTC zones.
 */
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { monthBounds } from "@/lib/domain/calendar";

/** Fallback timezone when a user's profile has none / an unparseable one. */
export const FALLBACK_TZ = "Asia/Kuala_Lumpur";

/**
 * Civil "today" (YYYY-MM-DD) in the given IANA timezone; falls back to MY time.
 * `en-CA` formats as the ISO-like `YYYY-MM-DD` we want. Cloned from the reminders
 * cron (intentionally not shared, to keep this phase from modifying that route).
 */
export function todayISOFor(timezone: string | null | undefined): string {
  const zone = timezone && timezone.trim() ? timezone.trim() : FALLBACK_TZ;
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, ...opts }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: FALLBACK_TZ, ...opts }).format(new Date());
  }
}

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/; // YYYY-MM, month 01..12
const YEAR_KEY_RE = /^\d{4}$/; // YYYY

/** A valid monthly period key, e.g. "2026-06". */
export function isValidMonthKey(key: string): boolean {
  return MONTH_KEY_RE.test(key);
}

/** A valid yearly period key, e.g. "2025". */
export function isValidYearKey(key: string): boolean {
  return YEAR_KEY_RE.test(key);
}

export type PeriodKeyKind = "month" | "year";

/** Classify a period key as monthly / yearly, or null when it matches neither. */
export function classifyPeriodKey(key: string): PeriodKeyKind | null {
  if (isValidMonthKey(key)) return "month";
  if (isValidYearKey(key)) return "year";
  return null;
}

/** Day-of-month (1..31) of a civil ISO date. */
export function dayOfMonth(iso: string): number {
  return parseISODate(iso).getDate();
}

/** "2026-06" → { year: 2026, month0: 5 }. Assumes a validated month key. */
function monthKeyParts(monthKey: string): { year: number; month0: number } {
  const [y, m] = monthKey.split("-").map(Number);
  return { year: y, month0: m - 1 };
}

/** Inclusive civil-date bounds of a month_key, via the shared calendar helper. */
export function monthKeyBounds(monthKey: string): { startISO: string; endISO: string } {
  const { year, month0 } = monthKeyParts(monthKey);
  return monthBounds(year, month0);
}

/** Inclusive civil-date bounds of a year_key (Jan 1 .. Dec 31). */
export function yearKeyBounds(yearKey: string): { startISO: string; endISO: string } {
  const year = Number(yearKey);
  return {
    startISO: monthBounds(year, 0).startISO,
    endISO: monthBounds(year, 11).endISO,
  };
}

/** Previous month key ("2026-01" → "2025-12"). Pure. */
export function prevMonthKey(monthKey: string): string {
  const { year, month0 } = monthKeyParts(monthKey);
  const d = new Date(year, month0, 1);
  d.setMonth(d.getMonth() - 1);
  return toMonthKey(d);
}

/** Next month key ("2026-12" → "2027-01"). Pure. */
export function nextMonthKey(monthKey: string): string {
  const { year, month0 } = monthKeyParts(monthKey);
  const d = new Date(year, month0, 1);
  d.setMonth(d.getMonth() + 1);
  return toMonthKey(d);
}

/** Previous year key ("2025" → "2024"). Pure. */
export function prevYearKey(yearKey: string): string {
  return String(Number(yearKey) - 1);
}

/** Format a Date as a month_key (YYYY-MM) using local fields. */
function toMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The month_key of the month BEFORE the given civil today. A report delivered on
 * 2026-07-01 covers 2026-06. Pure.
 */
export function prevMonthKeyFromToday(todayISO: string): string {
  const d = parseISODate(todayISO);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return toMonthKey(d);
}

/** The year_key of the year BEFORE the given civil today. Pure. */
export function prevYearKeyFromToday(todayISO: string): string {
  return String(parseISODate(todayISO).getFullYear() - 1);
}

/**
 * Is this month_key a fully-closed month relative to `todayISO`? A month is
 * closed once today's calendar month is strictly later (same-month = current).
 * Drives R6's "statements only cover closed periods" guard.
 */
export function isClosedMonth(monthKey: string, todayISO: string): boolean {
  const t = parseISODate(todayISO);
  const todayMonthKey = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
  return monthKey < todayMonthKey;
}

/** Is this year_key a fully-closed year relative to `todayISO`? */
export function isClosedYear(yearKey: string, todayISO: string): boolean {
  return Number(yearKey) < parseISODate(todayISO).getFullYear();
}

/** Whether `todayISO` falls within the first `windowDays` of its month (catch-up). */
export function withinGenerationWindow(todayISO: string, windowDays = 3): boolean {
  return dayOfMonth(todayISO) <= windowDays;
}
