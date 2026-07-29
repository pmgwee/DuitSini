import type { Subscription } from "@/types/subscription";
import { chargeDatesInRange, isActive } from "@/lib/domain/subscription";
import { parseISODate, toISODate } from "@/lib/domain/dates";
import { DEFAULT_REMINDER_OFFSETS, type Category } from "@/lib/constants";

/**
 * Canonicalize a raw offsets array: keep integer days 0–60, dedupe, sort desc.
 * Empty / null / undefined → DEFAULT_REMINDER_OFFSETS, so a corrupt or missing
 * value can never silently mute the sweep. Pure. Used by the settings API
 * (canonicalize before upsert) and the cron (global default → safe array).
 */
export function sanitizeOffsets(input: number[] | null | undefined): number[] {
  const seen = new Set<number>();
  const kept = (input ?? [])
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 60)
    .sort((a, b) => b - a)
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  return kept.length > 0 ? kept : [...DEFAULT_REMINDER_OFFSETS];
}

export type ReminderKind = "renewal" | "trial";

/**
 * A reminder currently due for a subscription. One per (subscription × charge
 * date × offset). The cron route expands each into per-channel deliveries.
 */
export interface DueReminder {
  subscriptionId: string;
  /** The charge date the reminder is about (civil YYYY-MM-DD). */
  chargeISO: string;
  /** The offset (days before the charge) this reminder fires at. */
  offsetDays: number;
  /** Civil date this reminder is due on (= chargeISO − offsetDays). */
  dueISO: string;
  /** "trial" only when chargeISO equals the sub's trial-end date. */
  kind: ReminderKind;
  /** Snapshot for message building (the cron route doesn't re-read the sub). */
  name: string;
  /** Carried so the digest can group reminders under category headers. */
  category: Category;
  amount: number;
  currency: string;
  unsubscribeUrl: string | null;
}

/**
 * Deterministic idempotency key for a delivery. The unique partial index on
 * `notification_deliveries.dedupe_key` makes a repeat send of the SAME
 * (subscription, channel, offset, charge) a no-op, so duplicate/missed cron
 * runs can't double-send. NOTE: the numeric offset (not the literal word
 * "trial") is used even for trial reminders — a trial converts at several
 * offsets (7/3/1), and using the bare "trial" marker would collide those into
 * one key and silently drop all but the first. The trial-ness is carried
 * separately in the message label and the ledger's payload_json.
 */
export function reminderDedupeKey(
  subscriptionId: string,
  channel: string,
  offsetDays: number,
  chargeISO: string,
): string {
  return `${subscriptionId}:${channel}:${offsetDays}:${chargeISO}`;
}

/** Shift a civil ISO date by `days` (handles month/year rollover). Pure. */
function shiftISO(iso: string, days: number): string {
  const d = parseISODate(iso); // local-midnight Date; no clock read
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** A floor so a sub whose largest offset is small still gets a wide enough look-ahead. */
const MIN_LOOKAHEAD = 7;

/**
 * Derive every reminder currently due for the given subscriptions.
 *
 * PURE: no I/O and no clock reads — the caller passes the user's civil "today"
 * (already converted into their timezone). A reminder for charge date C at
 * offset N is due on civil date C − N; it is sent when that due date is TODAY
 * (normal) or YESTERDAY (one-day catch-up for a missed cron run), never older.
 *
 * Reminders come straight from the existing charge-series engine, so:
 *  - cancelled subs are dropped by `isActive` (no cancel logic needed);
 *  - a changed renewal date just re-derives on the next run (no reschedule);
 *  - a trial's first charge IS its trial-end date (the engine anchors there),
 *    so that reminder is labelled "trial".
 */
export function deriveDueReminders(subs: Subscription[], todayISO: string): DueReminder[] {
  const yesterdayISO = shiftISO(todayISO, -1);
  const out: DueReminder[] = [];

  for (const sub of subs) {
    if (!isActive(sub)) continue;
    const offsets = (sub.reminderOffsetsDays ?? []).filter((n) => Number.isFinite(n) && n >= 0);
    if (offsets.length === 0) continue;

    // due = charge − N. For due ∈ {yesterday, today}, charge ranges up to
    // today + max(N); look one extra day ahead for safety.
    const maxOffset = Math.max(...offsets, MIN_LOOKAHEAD);
    const windowStart = shiftISO(todayISO, -1);
    const windowEnd = shiftISO(todayISO, maxOffset + 1);
    const charges = chargeDatesInRange(sub, windowStart, windowEnd);

    for (const chargeISO of charges) {
      const isTrialConversion = sub.isTrial && sub.freeTrialEndAt === chargeISO;
      for (const n of offsets) {
        const dueISO = shiftISO(chargeISO, -n);
        if (dueISO !== todayISO && dueISO !== yesterdayISO) continue;
        out.push({
          subscriptionId: sub.id,
          chargeISO,
          offsetDays: n,
          dueISO,
          kind: isTrialConversion ? "trial" : "renewal",
          name: sub.name,
          category: sub.category,
          amount: sub.amount,
          currency: sub.currency,
          unsubscribeUrl: sub.unsubscribeUrl,
        });
      }
    }
  }

  return out;
}
