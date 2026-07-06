import { toISODate } from "./dates";

export interface CalendarCell {
  /** Civil ISO date (YYYY-MM-DD). */
  iso: string;
  /** Day of month (1..31). */
  day: number;
  /** Whether the cell belongs to the focused month. */
  inMonth: boolean;
  /** Whether the cell is today. */
  isToday: boolean;
}

/** Monday-indexed weekday (0 = Monday … 6 = Sunday). */
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * A fixed 42-cell (6-week) grid covering the focused month, Monday-start. It
 * always includes leading/trailing days from adjacent months so the grid renders
 * as a complete rectangle regardless of where the 1st falls.
 */
export function calendarGrid(
  year: number,
  month: number, // 0-indexed
  todayISO: string = toISODate(new Date()),
): CalendarCell[] {
  const firstOfMonth = new Date(year, month, 1);
  const gridStartDay = 1 - mondayIndex(firstOfMonth); // date of the first cell
  const cells: CalendarCell[] = [];
  for (let i = 0; i < 42; i++) {
    const date = new Date(year, month, gridStartDay + i);
    const iso = toISODate(date);
    cells.push({
      iso,
      day: date.getDate(),
      inMonth: date.getMonth() === month,
      isToday: iso === todayISO,
    });
  }
  return cells;
}

/** Inclusive civil-date bounds of a month, as ISO strings. */
export function monthBounds(year: number, month: number): { startISO: string; endISO: string } {
  return {
    startISO: toISODate(new Date(year, month, 1)),
    endISO: toISODate(new Date(year, month + 1, 0)),
  };
}

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
