// Local diagnostic: replicate lib/domain/renewal.ts + lib/reminders/engine.ts
// EXACTLY (same date-fns calls, same civil-date math) and run them against the
// live U Mobile subscription to prove whether the 7-day reminder is due today.
// Pure read-only: fetches one row, prints the derivation. No writes, no sends.
import { addDays, addMonths, addWeeks } from "date-fns";

const SB_URL = "https://ldsxmigqfgfcisweqckk.supabase.co";
const SRK = process.env.SRK;
const HEADERS = { apikey: SRK, Authorization: `Bearer ${SRK}` };

// ---- date helpers (mirror lib/domain/dates.ts) ----
const parseISODate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d); // local midnight, no clock read
};
const toISODate = (dt) => {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// ---- mirror renewal.ts stepDate ----
function stepDate(date, cycle, intervalCount) {
  const n = Math.max(1, intervalCount);
  switch (cycle) {
    case "weekly": return addWeeks(date, 1);
    case "monthly": return addMonths(date, 1);
    case "quarterly": return addMonths(date, 3);
    case "semiannual": return addMonths(date, 6);
    case "annual": return addMonths(date, 12);
    case "custom_days": return addDays(date, n);
    case "custom_months": return addMonths(date, n);
    case "one_off": return date;
  }
}

const MAX_STEPS = 6000;
// ---- mirror renewal.ts chargesInRange ----
function chargesInRange(anchorISO, cycle, intervalCount, startISO, endISO) {
  const start = parseISODate(startISO).getTime();
  const end = parseISODate(endISO).getTime();
  const dates = [];
  if (cycle === "one_off") {
    const single = parseISODate(anchorISO).getTime();
    if (single >= start && single <= end) dates.push(toISODate(parseISODate(anchorISO)));
    return dates;
  }
  let current = parseISODate(anchorISO);
  let steps = 0;
  while (current.getTime() < start && steps < MAX_STEPS) { current = stepDate(current, cycle, intervalCount); steps++; }
  if (current.getTime() < start) return dates;
  while (current.getTime() <= end && steps < MAX_STEPS) {
    dates.push(toISODate(current));
    current = stepDate(current, cycle, intervalCount);
    steps++;
  }
  return dates;
}

const shiftISO = (iso, days) => { const d = parseISODate(iso); d.setDate(d.getDate() + days); return toISODate(d); };
const MIN_LOOKAHEAD = 7;

// ---- mirror engine.ts deriveDueReminders (for ONE sub) ----
function deriveForSub(sub, todayISO) {
  const offsets = (sub.reminderOffsetsDays ?? []).filter((n) => Number.isFinite(n) && n >= 0);
  if (sub.isPaused || sub.isCancelled) return { skipped: "inactive", charges: [], due: [] };
  if (offsets.length === 0) return { skipped: "no offsets", charges: [], due: [] };
  const yesterdayISO = shiftISO(todayISO, -1);
  const maxOffset = Math.max(...offsets, MIN_LOOKAHEAD);
  const windowStart = shiftISO(todayISO, -1);
  const windowEnd = shiftISO(todayISO, maxOffset + 1);
  const anchor = sub.isTrial && sub.freeTrialEndAt ? sub.freeTrialEndAt : sub.startDate;
  const charges = chargesInRange(anchor, sub.billingCycle, sub.intervalCount, windowStart, windowEnd);
  const due = [];
  for (const chargeISO of charges) {
    for (const n of offsets) {
      const dueISO = shiftISO(chargeISO, -n);
      if (dueISO !== todayISO && dueISO !== yesterdayISO) continue;
      due.push({ chargeISO, offsetDays: n, dueISO, anchor, windowStart, windowEnd });
    }
  }
  return { skipped: null, charges, due };
}

// ---- fetch the real sub + profile ----
const uid = "92c3c770-51b4-48eb-b196-fe7214af2619";
const [subRes, profRes] = await Promise.all([
  fetch(`${SB_URL}/rest/v1/subscriptions?id=eq.d9e9ef79-e48f-4210-be6d-be22b488157a&select=*`, { headers: HEADERS }).then((r) => r.json()),
  fetch(`${SB_URL}/rest/v1/user_profiles?user_id=eq.${uid}&select=*`, { headers: HEADERS }).then((r) => r.json()),
]);
const row = subRes[0];
const prof = profRes[0];
// Resolve effective offsets exactly like the cron (sub null -> global sanitize)
const rawGlobal = prof.reminder_offsets_days ?? [7, 3, 1];
const globalOffsets = [...new Set((rawGlobal).filter((n) => Number.isInteger(n) && n >= 0 && n <= 60))].sort((a, b) => b - a);
const effectiveOffsets = row.reminder_offsets_days == null ? globalOffsets : row.reminder_offsets_days;
const sub = {
  startDate: row.start_date,
  billingCycle: row.billing_cycle,
  intervalCount: row.interval_count,
  isTrial: row.is_trial,
  freeTrialEndAt: row.free_trial_end_at,
  isPaused: row.is_paused,
  isCancelled: row.is_cancelled,
  reminderOffsetsDays: effectiveOffsets,
};

console.log("=== U Mobile sub (effective) ===");
console.log({ name: row.name, start_date: row.start_date, billing_cycle: row.billing_cycle, interval_count: row.interval_count, is_trial: row.is_trial, is_paused: row.is_paused, is_cancelled: row.is_cancelled, raw_offsets: row.reminder_offsets_days, effective_offsets: effectiveOffsets, channels: row.notification_channels });
console.log("=== profile ===");
console.log({ timezone: prof.timezone, telegram_enabled: prof.telegram_enabled, telegram_chat_id: prof.telegram_chat_id, global_offsets: rawGlobal });

// Run for today in the user's tz (UTC) — same as the cron at 02:00 UTC.
const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: prof.timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
console.log("=== derivation for today =", todayISO, "(cron computes todayISO in tz:", prof.timezone, ") ===");
const r = deriveForSub(sub, todayISO);
console.log("anchor:", r.due[0]?.anchor ?? (sub.isTrial && sub.freeTrialEndAt ? sub.freeTrialEndAt : sub.start_date));
console.log("charges in look-ahead window:", r.charges);
console.log(">>> REMINDERS DUE TODAY/YESTERDAY:", JSON.stringify(r.due, null, 2));

// Also show the full upcoming charge series near July 31 so we can see the anchor's effect.
const series = chargesInRange(sub.start_date, sub.billingCycle, sub.interval_count, "2026-07-01", "2026-09-30");
console.log("=== charge series Jul–Sep 2026 (anchor", sub.start_date, ", monthly) ===");
console.log(series);
