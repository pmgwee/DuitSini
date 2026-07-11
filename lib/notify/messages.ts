import { escapeTelegramHTML } from "./telegram";
import type { NotifyPayload } from "./types";
import { formatCurrency, roundMoney } from "@/lib/domain/money";
import { formatMYR, toMYR } from "@/lib/domain/fx";
import { daysUntil, formatLongDate, parseISODate } from "@/lib/domain/dates";
import { CATEGORY_EMOJI, CATEGORY_META, type Category } from "@/lib/constants";
import type { DueReminder } from "@/lib/reminders/engine";
import type { MonthlyReportTotalsV1, YearlyReportTotalsV1 } from "@/lib/reports/types";

/** "today" / "tomorrow" / "in N days" / past phrasing for the days-until count. */
function whenPhrase(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1) return `in ${days} days`;
  // Caught up late (e.g. an offset-0 reminder sent the day after the charge):
  // the charge already happened, so phrase it as past, not "today".
  return `${Math.abs(days)} days ago`;
}

/** Original currency plus an MYR equivalent string (empty when already MYR). */
function moneyFor(amount: number, currency: string): string {
  const orig = formatCurrency(amount, currency);
  if (currency === "MYR") return orig;
  return `${orig} · ${formatMYR(roundMoney(toMYR(amount, currency)))}`;
}

/**
 * One reminder as a single HTML line: icon + bold name + verb + when + money.
 * User-controlled values (name, money) are HTML-escaped; the verb/phrasing are
 * safe literals. Shared by the single-reminder and the digest formats.
 */
function reminderLineHTML(r: DueReminder, todayISO: string, withCategoryEmoji = false): string {
  const days = daysUntil(r.chargeISO, parseISODate(todayISO));
  const verb = r.kind === "trial" ? "trial converts" : "renews";
  const icon = r.kind === "trial" ? "⚠️" : "⏰";
  // The category emoji only goes inline for a standalone (single) reminder,
  // where there's no group header to carry it; inside a digest the group
  // header marks the category, so the per-line emoji would be redundant.
  const catEmoji = withCategoryEmoji ? CATEGORY_EMOJI[r.category] ?? "" : "";
  return `${icon}${catEmoji ? ` ${catEmoji}` : ""} <b>${escapeTelegramHTML(r.name)}</b> ${verb} ${whenPhrase(
    days,
  )} — ${escapeTelegramHTML(formatLongDate(r.chargeISO))} · ${escapeTelegramHTML(
    moneyFor(r.amount, r.currency),
  )}`;
}

/**
 * Group reminders by category for the digest, ordered so the most urgent
 * category leads. First sort trials-first then by soonest charge (a trial
 * converting is the highest-stakes event — an unwanted new charge), then bucket
 * into category groups in order of first appearance — so the category holding
 * the single most-urgent reminder comes first. Within a category the items keep
 * the trials-first / soonest-charge order. Stable on ties.
 */
function groupByCategoryForDigest(
  reminders: DueReminder[],
  todayISO: string,
): { category: Category; items: DueReminder[] }[] {
  const sorted = [...reminders].sort((a, b) => {
    const at = a.kind === "trial" ? 0 : 1;
    const bt = b.kind === "trial" ? 0 : 1;
    if (at !== bt) return at - bt;
    return daysUntil(a.chargeISO, parseISODate(todayISO)) - daysUntil(b.chargeISO, parseISODate(todayISO));
  });
  const groups: { category: Category; items: DueReminder[] }[] = [];
  const indexByCategory = new Map<Category, number>();
  for (const r of sorted) {
    let gi = indexByCategory.get(r.category);
    if (gi === undefined) {
      gi = groups.length;
      groups.push({ category: r.category, items: [] });
      indexByCategory.set(r.category, gi);
    }
    groups[gi].items.push(r);
  }
  return groups;
}

/**
 * Build the message for a set of due reminders sharing one due date.
 *
 * - ONE reminder  → a direct, header-less line (reads as a natural nudge) with
 *   the category emoji inline, plus an `Unsubscribe:` line when the sub has one.
 * - TWO or more   → a single DAILY DIGEST grouped by category: a `📋 N reminders
 *   …` header, then a `{emoji} {Category}` section per category (most urgent
 *   first) with its reminders listed underneath (trials first). Per-line
 *   unsubscribe links are omitted in the digest to keep it scannable. This is
 *   the anti-spam fix: a user with many subs gets one morning message, not N.
 *
 * `dueISO` (the civil date these reminders are FOR) drives the header wording,
 * so a catch-up digest for a missed day reads correctly ("due <date>") instead
 * of wrongly claiming "today".
 */
export function buildDigestMessage(
  reminders: DueReminder[],
  todayISO: string,
  dueISO: string,
): NotifyPayload {
  // Single reminder — direct message (no digest header). The category emoji
  // goes inline (there's no group header to carry it).
  if (reminders.length === 1) {
    const r = reminders[0];
    const parts = [reminderLineHTML(r, todayISO, true)];
    if (r.unsubscribeUrl) {
      parts.push(`Unsubscribe: ${escapeTelegramHTML(r.unsubscribeUrl)}`);
    }
    const html = parts.join("\n");
    return { text: html.replace(/<[^>]+>/g, ""), html };
  }

  // Two or more — bundle into a category-grouped digest: a count header, then
  // one "{emoji} {Category}" section per category with its reminders listed
  // underneath. Blank lines between sections keep it scannable.
  const groups = groupByCategoryForDigest(reminders, todayISO);
  const when = dueISO === todayISO ? "today" : formatLongDate(dueISO);
  const sections: string[] = [`📋 ${reminders.length} reminders due ${when}:`];
  for (const g of groups) {
    const label = CATEGORY_META[g.category]?.label ?? g.category;
    const lines = [`${CATEGORY_EMOJI[g.category] ?? ""} ${label}`];
    for (const r of g.items) lines.push(reminderLineHTML(r, todayISO, false));
    sections.push(lines.join("\n"));
  }
  const html = sections.join("\n\n");
  return { text: html.replace(/<[^>]+>/g, ""), html };
}

/* ============================================================
   Report highlight messages (Phase 4)
   Compact Telegram highlights + a deep link to the full in-app
   statement. The page carries the detail; this is the teaser.
   ============================================================ */

/** "▲ 5.2% vs May" / "▼ 3% vs 2024" / "new" (null delta). */
function deltaPhrase(deltaPct: number | null, vsLabel: string): string {
  if (deltaPct == null) return "new";
  const arrow = deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "→";
  return `${arrow} ${Math.abs(deltaPct).toFixed(deltaPct % 1 === 0 ? 0 : 1)}% vs ${vsLabel}`;
}

/** Long month name from a month_key, e.g. "2026-06" → "June". */
function monthName(monthKey: string): string {
  const [, mm] = monthKey.split("-");
  return parseISODate(`${monthKey}-01`).toLocaleDateString("en-GB", { month: "long" });
}

/** Previous-period label for the delta phrase: "May" (monthly) / "2024" (yearly). */
function prevMonthName(monthKey: string): string {
  const [yyyy, mm] = monthKey.split("-").map(Number);
  const d = new Date(yyyy, mm - 1, 1);
  d.setMonth(d.getMonth() - 1);
  return d.toLocaleDateString("en-GB", { month: "long" });
}

/** "Streaming RM 120 · SaaS RM 96 · Music RM 45" — top N categories. */
function topCategoriesLine(
  categories: { category: string; label: string; totalMYR: number }[],
  n = 3,
): string {
  return categories
    .slice(0, n)
    .map((c) => `${escapeTelegramHTML(c.label)} ${escapeTelegramHTML(formatMYR(c.totalMYR))}`)
    .join(" · ");
}

/**
 * Build the Telegram highlights message for a monthly statement. `appUrl` is the
 * public site root (NEXT_PUBLIC_APP_URL); the deep link opens the full report.
 */
export function buildMonthlyReportMessage(
  totals: MonthlyReportTotalsV1,
  appUrl: string,
): NotifyPayload {
  const link = `${appUrl.replace(/\/+$/, "")}/reports/${totals.monthKey}`;
  const lines: string[] = [
    `📊 <b>Your ${escapeTelegramHTML(monthName(totals.monthKey))} report</b>`,
    `Spent: ${escapeTelegramHTML(formatMYR(totals.totalMYR))} (${escapeTelegramHTML(
      deltaPhrase(totals.deltaPct, prevMonthName(totals.monthKey)),
    )}) · ${totals.activeCount} active`,
  ];
  if (totals.categories.length > 0) {
    lines.push(`Top: ${topCategoriesLine(totals.categories)}`);
  }
  const trialNote =
    totals.trialsConverting.length > 0
      ? ` · ${totals.trialsConverting.length} trial${totals.trialsConverting.length === 1 ? "" : "s"} converting`
      : "";
  lines.push(`Next month: ~${escapeTelegramHTML(formatMYR(totals.upcomingTotalMYR))} expected${trialNote}`);
  if (totals.cancellationSavingsMYR > 0) {
    lines.push(`💰 Saving ${escapeTelegramHTML(formatMYR(totals.cancellationSavingsMYR))}/mo from cancelled subs`);
  }
  lines.push("");
  lines.push(`<a href="${escapeTelegramHTML(link)}">Open the full report</a>`);
  const html = lines.join("\n");
  return { text: html.replace(/<[^>]+>/g, ""), html };
}

/**
 * Build the Telegram highlights message for a yearly statement.
 */
export function buildYearlyReportMessage(
  totals: YearlyReportTotalsV1,
  appUrl: string,
): NotifyPayload {
  const link = `${appUrl.replace(/\/+$/, "")}/reports/${totals.yearKey}`;
  const prevYear = String(Number(totals.yearKey) - 1);
  const lines: string[] = [
    `📊 <b>Your ${escapeTelegramHTML(totals.yearKey)} report</b>`,
    `Spent: ${escapeTelegramHTML(formatMYR(totals.totalMYR))} (${escapeTelegramHTML(
      deltaPhrase(totals.deltaPct, prevYear),
    )})`,
  ];
  if (totals.categories.length > 0) {
    lines.push(`Top: ${topCategoriesLine(totals.categories)}`);
  }
  lines.push(`Avg/month: ${escapeTelegramHTML(formatMYR(roundMoney(totals.totalMYR / 12)))}`);
  if (totals.topSubscriptions.length > 0) {
    const top = totals.topSubscriptions
      .slice(0, 3)
      .map(
        (t) => `${escapeTelegramHTML(t.name)} ${escapeTelegramHTML(formatMYR(t.totalMYR))}`,
      )
      .join(" · ");
    lines.push(`Biggest: ${top}`);
  }
  if (totals.cancellationSavingsMYR > 0) {
    lines.push(`💰 Saved ${escapeTelegramHTML(formatMYR(totals.cancellationSavingsMYR))} from cancelled subs`);
  }
  lines.push("");
  lines.push(`<a href="${escapeTelegramHTML(link)}">Open the full report</a>`);
  const html = lines.join("\n");
  return { text: html.replace(/<[^>]+>/g, ""), html };
}
