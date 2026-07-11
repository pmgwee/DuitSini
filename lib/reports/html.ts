/**
 * Self-contained HTML report renderer.
 *
 * Produces a complete `<!doctype html>` document from a stored snapshot: inline
 * CSS only, no JavaScript, no external fonts or assets — so the downloaded file
 * renders identically from `file://` with no network. This IS the export (PDF
 * generation is out of scope; the HTML prints cleanly to PDF via the browser).
 *
 * Every user-controlled string (subscription names) is HTML-escaped via a small
 * local escaper — NOT `escapeTelegramHTML` (that only handles the three chars
 * Telegram's parser treats as markup; an HTML document needs the full set).
 */
import { formatCurrency, roundMoney } from "@/lib/domain/money";
import { formatMYR } from "@/lib/domain/fx";
import { formatLongDate, formatShortDate } from "@/lib/domain/dates";
import { CATEGORY_COLOR } from "@/lib/constants";
import type { Category } from "@/lib/constants";
import type { MonthlyReportTotalsV1, YearlyReportTotalsV1 } from "./types";

/** Escape the five characters with meaning in an HTML document body/attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The category color as a concrete CSS literal. The export document is
 * self-contained (no globals.css), so it CANNOT use `var(--cat-*)` tokens —
 * those would be unresolved at computed-value time and the bars would render
 * transparent. CATEGORY_COLOR is the literal OKLCH mirror kept for exactly this
 * (and for Recharts `<Cell fill>`).
 */
function categoryColorCss(category: string): string {
  return CATEGORY_COLOR[category as Category] ?? CATEGORY_COLOR.other;
}

/** Format a signed delta percent with an arrow, e.g. "▲ 5.2%". */
function formatDelta(deltaPct: number | null): string {
  if (deltaPct == null) return "new";
  const arrow = deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "→";
  return `${arrow} ${Math.abs(deltaPct).toFixed(1)}%`;
}

/** Shared <head> + opening body chrome. */
function documentOpen(title: string, subtitle: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 40px 20px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #0f172a;
    background: #f8fafc;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e2e8f0; background: #0b1220; }
    .card { background: #131c2e; border-color: #243049; }
    .muted { color: #94a3b8; }
    .row { border-color: #243049 !important; }
    .bar-track { background: #1e293b; }
    table th { color: #94a3b8; }
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  .card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 20px;
  }
  .muted { color: #64748b; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 14px; margin: 0 0 14px; font-weight: 600; }
  .headline { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  .headline .amount { font-size: 38px; font-weight: 700; letter-spacing: -0.02em; }
  .delta { font-size: 14px; font-weight: 600; }
  .delta.up { color: #16a34a; }   /* increase = green */
  .delta.down { color: #dc2626; } /* decrease = red */
  .delta.flat { color: #64748b; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 18px; }
  @media (max-width: 560px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
  .tile { background: #f1f5f9; border-radius: 12px; padding: 12px; }
  .tile .v { font-size: 18px; font-weight: 700; }
  .tile .l { font-size: 11px; }
  .cat-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .cat-row .name { width: 130px; font-size: 13px; }
  .cat-row .bar-track { flex: 1; height: 10px; background: #e2e8f0; border-radius: 999px; overflow: hidden; }
  .cat-row .bar { height: 100%; border-radius: 999px; }
  .cat-row .val { width: 80px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; }
  .row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 0; border-top: 1px solid #eef2f7;
  }
  .row:first-child { border-top: 0; }
  .row .left { min-width: 0; }
  .row .name { font-size: 14px; font-weight: 500; }
  .row .sub { font-size: 12px; }
  .row .right { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 999px; background: #fef3c7; color: #92400e; margin-left: 6px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #64748b; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
  td { padding: 9px 8px; border-bottom: 1px solid #eef2f7; font-size: 13px; }
  td.r, th.r { text-align: right; }
  .foot { text-align: center; font-size: 11px; margin-top: 8px; }
  @media print { body { padding: 0; background: #fff; } .card { break-inside: avoid; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="card" style="text-align:center;">
    <h1>${escapeHtml(title)}</h1>
    <div class="muted">${escapeHtml(subtitle)}</div>
  </div>`;
}

const documentClose = `\n</div>\n</body>\n</html>\n`;

/** Spend-summary card (headline + delta + 4 tiles). */
function spendCard(
  totalMYR: number,
  deltaPct: number | null,
  tiles: { label: string; value: string }[],
): string {
  const deltaClass = deltaPct == null ? "flat" : deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : "flat";
  const tilesHtml = tiles
    .map(
      (t) =>
        `<div class="tile"><div class="v">${escapeHtml(t.value)}</div><div class="l muted">${escapeHtml(
          t.label,
        )}</div></div>`,
    )
    .join("");
  return `<div class="card">
  <h2>Spend summary</h2>
  <div class="headline">
    <span class="amount">${escapeHtml(formatMYR(totalMYR))}</span>
    <span class="delta ${deltaClass}">${escapeHtml(formatDelta(deltaPct))}</span>
  </div>
  <div class="tiles">${tilesHtml}</div>
</div>`;
}

/** Category breakdown as CSS bars (no chart library — renders standalone). */
function categoriesCard(
  categories: { category: string; label: string; totalMYR: number }[],
  prevLabel: string,
): string {
  if (categories.length === 0) {
    return `<div class="card"><h2>By category</h2><p class="muted">No spend in this period.</p></div>`;
  }
  const max = Math.max(1, ...categories.map((c) => c.totalMYR));
  const rows = categories
    .map((c) => {
      const pct = Math.max(2, Math.round((c.totalMYR / max) * 100));
      return `<div class="cat-row">
  <span class="name">${escapeHtml(c.label)}</span>
  <span class="bar-track"><span class="bar" style="width:${pct}%;background:${categoryColorCss(c.category)};"></span></span>
  <span class="val">${escapeHtml(formatMYR(c.totalMYR))}</span>
</div>`;
    })
    .join("");
  return `<div class="card">
  <h2>By category <span class="muted" style="font-weight:400;">· ${escapeHtml(prevLabel)}</span></h2>
  ${rows}
</div>`;
}

/**
 * Render a monthly statement as a self-contained HTML document string.
 */
export function renderMonthlyReportHTML(totals: MonthlyReportTotalsV1): string {
  const [yyyy, mm] = totals.monthKey.split("-");
  const monthLabel = new Date(Number(yyyy), Number(mm) - 1, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });

  const chargeRows = totals.charges
    .map((c) => {
      const myrHint =
        c.currency === "MYR" ? "" : ` <span class="muted">≈ ${escapeHtml(formatMYR(c.amountMYR))}</span>`;
      const pill = c.isTrialConversion ? `<span class="pill">Trial</span>` : "";
      return `<tr>
  <td>${escapeHtml(formatShortDate(c.dateISO))}</td>
  <td>${escapeHtml(c.name)}${pill}</td>
  <td class="r">${escapeHtml(formatCurrency(c.amount, c.currency))}${myrHint}</td>
</tr>`;
    })
    .join("");

  const chargesCard =
    totals.charges.length === 0
      ? `<div class="card"><h2>Charges</h2><p class="muted">No charges landed this month.</p></div>`
      : `<div class="card">
  <h2>Charges this month</h2>
  <table>
    <thead><tr><th>Date</th><th>Subscription</th><th class="r">Amount</th></tr></thead>
    <tbody>${chargeRows}</tbody>
  </table>
</div>`;

  const trialRows = totals.trialsConverting
    .map(
      (t) =>
        `<div class="row"><div class="left"><div class="name">${escapeHtml(
          t.name,
        )}</div><div class="sub muted">Converts ${escapeHtml(
          formatLongDate(t.dateISO),
        )}</div></div><div class="right">${escapeHtml(formatMYR(t.amountMYR))}</div></div>`,
    )
    .join("");

  const upcomingRows = totals.upcoming
    .slice(0, 12)
    .map(
      (u) =>
        `<div class="row"><div class="left"><div class="name">${escapeHtml(
          u.name,
        )}</div><div class="sub muted">${escapeHtml(formatShortDate(u.dateISO))}</div></div><div class="right">${escapeHtml(
          formatMYR(u.amountMYR),
        )}</div></div>`,
    )
    .join("");

  const forwardCard = `<div class="card">
  <h2>Looking ahead · next month</h2>
  <p class="muted" style="margin:0 0 14px;">Expected spend ${escapeHtml(
    formatMYR(totals.upcomingTotalMYR),
  )}${
    totals.trialsConverting.length > 0
      ? ` · ${totals.trialsConverting.length} trial${totals.trialsConverting.length === 1 ? "" : "s"} converting`
      : ""
  }.</p>
  ${trialRows}
  ${upcomingRows || `<p class="muted">No upcoming charges.</p>`}
</div>`;

  const savingsCard =
    totals.cancellationSavingsMYR > 0
      ? `<div class="card" style="text-align:center;">
  <div class="muted" style="font-size:12px;">You&apos;re saving</div>
  <div style="font-size:28px;font-weight:700;">${escapeHtml(formatMYR(totals.cancellationSavingsMYR))}<span style="font-size:14px;font-weight:500;" class="muted"> / month</span></div>
  <div class="muted" style="font-size:12px;">from cancelled subscriptions (${escapeHtml(
    formatMYR(roundMoney(totals.cancellationSavingsMYR * 12)),
  )} / year)</div>
</div>`
      : "";

  return (
    documentOpen("Monthly Report", `${monthLabel} · generated ${formatLongDate(totals.generatedOnISO)}`) +
    spendCard(totals.totalMYR, totals.deltaPct, [
      { label: "vs last month", value: formatDelta(totals.deltaPct) },
      { label: "active subs", value: String(totals.activeCount) },
      { label: "recurring / mo", value: formatMYR(totals.recurringMonthlyMYR) },
      { label: "charges", value: String(totals.charges.length) },
    ]) +
    categoriesCard(totals.categories, "MYR") +
    chargesCard +
    forwardCard +
    savingsCard +
    `<div class="foot muted">Subscription Agent · Monthly Report · ${escapeHtml(
      totals.monthKey,
    )}</div>` +
    documentClose
  );
}

/**
 * Render a yearly statement as a self-contained HTML document string.
 */
export function renderYearlyReportHTML(totals: YearlyReportTotalsV1): string {
  const yearLabel = totals.yearKey;

  // 12-month mini bar chart (CSS only).
  const maxBucket = Math.max(1, ...totals.monthlyBuckets.map((b) => b.totalMYR));
  const bars = totals.monthlyBuckets
    .map((b) => {
      const [, mm] = b.monthKey.split("-");
      const label = new Date(Number(totals.yearKey), Number(mm) - 1, 1).toLocaleDateString("en-GB", {
        month: "short",
      });
      const pct = Math.max(2, Math.round((b.totalMYR / maxBucket) * 100));
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;">
  <div style="font-size:10px;" class="muted">${b.totalMYR > 0 ? escapeHtml(formatMYR(b.totalMYR).replace("RM ", "")) : ""}</div>
  <div style="width:100%;height:120px;display:flex;align-items:flex-end;"><div style="width:100%;height:${pct}%;background:#7c3aed;border-radius:6px 6px 0 0;"></div></div>
  <div style="font-size:11px;" class="muted">${escapeHtml(label)}</div>
</div>`;
    })
    .join("");
  const trendCard = `<div class="card">
  <h2>Monthly spend · ${escapeHtml(yearLabel)}</h2>
  <div style="display:flex;align-items:flex-end;gap:8px;">${bars}</div>
</div>`;

  const topRows = totals.topSubscriptions
    .map(
      (t, i) =>
        `<div class="row"><div class="left"><div class="name"><span class="muted" style="display:inline-block;width:20px;">${i + 1}.</span>${escapeHtml(
          t.name,
        )}</div></div><div class="right">${escapeHtml(formatMYR(t.totalMYR))}</div></div>`,
    )
    .join("");
  const topCard = topRows
    ? `<div class="card"><h2>Top subscriptions</h2>${topRows}</div>`
    : "";

  const savingsCard =
    totals.cancellationSavingsMYR > 0
      ? `<div class="card" style="text-align:center;">
  <div class="muted" style="font-size:12px;">Saved this year (cancelled subs)</div>
  <div style="font-size:28px;font-weight:700;">${escapeHtml(formatMYR(totals.cancellationSavingsMYR))}</div>
</div>`
      : "";

  return (
    documentOpen("Yearly Report", `${yearLabel} · generated ${formatLongDate(totals.generatedOnISO)}`) +
    spendCard(totals.totalMYR, totals.deltaPct, [
      { label: "vs last year", value: formatDelta(totals.deltaPct) },
      { label: "avg / month", value: formatMYR(roundMoney(totals.totalMYR / 12)) },
      { label: "top categories", value: String(totals.categories.length) },
      { label: "top subs", value: String(totals.topSubscriptions.length) },
    ]) +
    trendCard +
    categoriesCard(totals.categories, "MYR") +
    topCard +
    savingsCard +
    `<div class="foot muted">Subscription Agent · Yearly Report · ${escapeHtml(
      totals.yearKey,
    )}</div>` +
    documentClose
  );
}
