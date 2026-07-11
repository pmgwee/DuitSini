import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  PiggyBank,
  Sparkles,
  TrendingUp,
  Trophy,
  FileText,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { isSupabaseEnabled } from "@/lib/data";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { classifyPeriodKey } from "@/lib/reports/period";
import type {
  MonthlyReportTotalsV1,
  YearlyReportTotalsV1,
} from "@/lib/reports/types";
import { formatCurrency, roundMoney } from "@/lib/domain/money";
import { HOME_CURRENCY, formatMYR } from "@/lib/domain/fx";
import { formatLongDate, formatShortDate } from "@/lib/domain/dates";
import { CATEGORY_COLOR } from "@/lib/constants";
import { ReportCategoryChart } from "@/features/reports/report-category-chart";
import { GenerateButton } from "@/features/reports/generate-button";
import { PrintButton } from "@/features/reports/print-button";
import { SendTelegramButton } from "@/features/reports/send-telegram-button";

export const dynamic = "force-dynamic";

/** "▲ 5.2%" / "▼ 3%" / "→ 0%" / "new". */
function deltaText(deltaPct: number | null): string {
  if (deltaPct == null) return "new";
  const arrow = deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "→";
  return `${arrow} ${Math.abs(deltaPct).toFixed(deltaPct % 1 === 0 ? 0 : 1)}%`;
}

/**
 * Delta text color. Increase → green, decrease → red (the user's requested
 * convention — up is good, down is bad — applied consistently to the detail
 * cards and the index list).
 */
function deltaColor(deltaPct: number | null): string {
  if (deltaPct == null) return "text-muted-foreground";
  if (deltaPct > 0) return "text-success";
  if (deltaPct < 0) return "text-danger";
  return "text-muted-foreground";
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success" | "danger";
}) {
  const color = accent === "success" ? "text-success" : accent === "danger" ? "text-danger" : "text-foreground";
  return (
    <div className="rounded-xl border border-border/50 bg-surface/30 p-3">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

/** Back-to-index link, rendered above the first card. */
function BackToReports() {
  return (
    <Link
      href="/reports"
      className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground print:hidden"
    >
      <ArrowLeft className="size-3.5" /> All reports
    </Link>
  );
}

/**
 * Report detail — renders a stored statement FROM its snapshot (totals_json),
 * never recomputing history. Validates the period key (YYYY-MM monthly, YYYY
 * yearly), 404s on a bad key or a missing row, and offers a "regenerate" prompt
 * when the snapshot is absent or an unrecognized version. Everything displayed
 * comes from the snapshot, so SSR is deterministic (no `new Date()`-derived
 * figures reach the client).
 */
export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ periodKey: string }>;
}) {
  const { periodKey } = await params;
  const kind = classifyPeriodKey(periodKey);
  if (!kind) notFound();

  if (!isSupabaseEnabled()) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <BackToReports />
        <EmptyState
          icon={FileText}
          title="Reports need the Supabase backend"
          description="Switch NEXT_PUBLIC_DATA_SOURCE to supabase to view stored statements."
        />
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  // Whether the user has Telegram linked (gates the "Send to Telegram" button).
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("telegram_chat_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const telegramLinked = !!(profile as { telegram_chat_id: string | null } | null)?.telegram_chat_id;

  const table = kind === "month" ? "monthly_reports" : "yearly_reports";
  const keyCol = kind === "month" ? "month_key" : "year_key";
  const { data } = await supabase
    .from(table)
    .select("totals_json, created_at")
    .eq("user_id", user.id)
    .eq(keyCol as never, periodKey)
    .maybeSingle();

  const row = data as { totals_json: Json | null; created_at: string } | null;
  if (!row) notFound();

  const totals = row.totals_json as { v?: number; generatedOnISO?: string } | null;
  const valid = totals?.v === 1;

  const periodLabel =
    kind === "month"
      ? (() => {
          const [yyyy, mm] = periodKey.split("-").map(Number);
          return new Date(yyyy, mm - 1, 1).toLocaleDateString("en-GB", {
            month: "long",
            year: "numeric",
          });
        })()
      : periodKey;

  if (!valid) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <BackToReports />
        <PageHeader title={periodLabel} description="This statement needs regenerating." />
        <EmptyState
          icon={Sparkles}
          title="Snapshot unavailable"
          description="This report row exists but its data is missing or an older format. Regenerate it from your current subscriptions."
          action={<GenerateButton periodKey={periodKey} label="Regenerate" />}
        />
      </div>
    );
  }

  // The snapshot stores the civil generation date deliberately — created_at is a
  // UTC instant whose date can be off-by-one for non-UTC users (CLAUDE.md dates).
  const generatedOn = totals.generatedOnISO ?? row.created_at.slice(0, 10);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <BackToReports />
      <PageHeader
        title={periodLabel}
        description={`Generated ${formatLongDate(generatedOn)}`}
        actions={
          <div className="flex items-center gap-2 print:hidden">
            <SendTelegramButton periodKey={periodKey} linked={telegramLinked} />
            <PrintButton />
          </div>
        }
      />

      {kind === "month" ? (
        <MonthlyDetail totals={totals as MonthlyReportTotalsV1} periodKey={periodKey} />
      ) : (
        <YearlyDetail totals={totals as YearlyReportTotalsV1} />
      )}
    </div>
  );
}

/* ----------------------------- Monthly detail ----------------------------- */

function MonthlyDetail({
  totals,
  periodKey,
}: {
  totals: MonthlyReportTotalsV1;
  periodKey: string;
}) {
  const prevMonthName = (() => {
    const [yyyy, mm] = periodKey.split("-").map(Number);
    const d = new Date(yyyy, mm - 1, 1);
    d.setMonth(d.getMonth() - 1);
    return d.toLocaleDateString("en-GB", { month: "long" });
  })();

  // Distinct subscription count per category (from the charge lines), for the
  // category legend. And the "most expensive" ranking, by per-charge MYR value.
  const counts: Record<string, number> = {};
  const namesByCategory = new Map<string, Set<string>>();
  const byName = new Map<string, { name: string; amount: number; currency: string; amountMYR: number }>();
  for (const c of totals.charges) {
    if (!namesByCategory.has(c.category)) namesByCategory.set(c.category, new Set());
    namesByCategory.get(c.category)!.add(c.name);
    if (!byName.has(c.name)) {
      byName.set(c.name, { name: c.name, amount: c.amount, currency: c.currency, amountMYR: c.amountMYR });
    }
  }
  for (const [cat, names] of namesByCategory) counts[cat] = names.size;
  const mostExpensive = [...byName.values()].sort((a, b) => b.amountMYR - a.amountMYR).slice(0, 5);

  return (
    <>
      {/* Spend summary (image 2): total + colored delta line + 4 tiles */}
      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
            <TrendingUp className="size-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Spent this month (MYR)
            </div>
            <div className="text-3xl font-semibold tracking-tight">
              {formatCurrency(totals.totalMYR, HOME_CURRENCY)}
            </div>
            <div className="mt-0.5 text-xs">
              <span className={`font-semibold ${deltaColor(totals.deltaPct)}`}>
                {deltaText(totals.deltaPct)}
              </span>
              <span className="ml-1.5 text-muted-foreground">vs {prevMonthName}</span>
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Subscription charge" value={String(totals.charges.length)} />
          <StatTile label="Trials subscription converting" value={String(totals.trialsConverting.length)} />
          <StatTile label="Recurring subscription" value={String(totals.activeCount)} />
          <StatTile label="MONTHLY Recurring (MYR)" value={formatMYR(totals.recurringMonthlyMYR)} />
        </div>
      </section>

      {/* Category breakdown — donut with a beside-the-chart hover detail + counts */}
      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium">By category</h2>
          <span className="text-xs text-muted-foreground">Spent this month (MYR)</span>
        </div>
        {totals.categories.length === 0 ? (
          <p className="text-xs text-muted-foreground">No spend in this period.</p>
        ) : (
          <ReportCategoryChart
            categories={totals.categories}
            counts={counts}
            centerLabel="spent"
            centerValue={totals.totalMYR}
          />
        )}
      </section>

      {/* Charges (statement lines) */}
      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <CalendarClock className="size-4 text-primary" /> Charges this month
        </h2>
        {totals.charges.length === 0 ? (
          <p className="text-xs text-muted-foreground">No charges landed this month.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/50">
            {totals.charges.map((c, i) => {
              const myr = c.currency === "MYR" ? null : formatMYR(roundMoney(c.amountMYR));
              return (
                <li key={`${c.dateISO}-${c.name}-${i}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: CATEGORY_COLOR[c.category as keyof typeof CATEGORY_COLOR] ?? CATEGORY_COLOR.other }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {c.name}
                      {c.isTrialConversion ? (
                        <span className="ml-2 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                          Trial converts
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{formatLongDate(c.dateISO)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium">{formatCurrency(c.amount, c.currency)}</div>
                    {myr ? <div className="text-[11px] text-muted-foreground">≈ {myr}</div> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Most expensive (by MYR value) — image 1 */}
        <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <Trophy className="size-4 text-primary" /> Most expensive
            <span className="font-normal text-muted-foreground">by MYR value</span>
          </h2>
          {mostExpensive.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active subscriptions.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {mostExpensive.map((s, i) => {
                const myr = s.currency === "MYR" ? null : formatMYR(roundMoney(s.amountMYR));
                return (
                  <li key={`${s.name}-${i}`} className="flex items-center gap-3 text-sm">
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="text-right">
                      <span className="font-medium">{formatCurrency(s.amount, s.currency)}</span>
                      {myr ? <span className="block text-[11px] text-muted-foreground">≈ {myr}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Looking ahead — trials styled like image 3 (Action needed) */}
        <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
          <h2 className="mb-1 text-sm font-medium">Looking ahead · next month</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Expected {formatMYR(totals.upcomingTotalMYR)}
            {totals.trialsConverting.length > 0
              ? ` · ${totals.trialsConverting.length} trial${totals.trialsConverting.length === 1 ? "" : "s"} converting`
              : ""}
          </p>

          {totals.trialsConverting.length > 0 ? (
            <div className="mb-3 rounded-xl border border-warning/30 bg-warning/6 p-4">
              <h3 className="mb-3 flex items-center gap-2 text-xs font-medium text-warning">
                <Sparkles className="size-3.5" />
                Action needed — trials converting
              </h3>
              <ul className="flex flex-col divide-y divide-warning/15">
                {totals.trialsConverting.map((t, i) => {
                  const myr = t.currency === "MYR" ? null : formatMYR(t.amountMYR);
                  return (
                    <li key={`${t.name}-${i}`} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{t.name}</div>
                        <div className="text-xs text-muted-foreground">Converts {formatLongDate(t.dateISO)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium">{formatCurrency(t.amount, t.currency)}</div>
                        {myr ? <div className="text-[11px] text-muted-foreground">≈ {myr}</div> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {totals.upcoming.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border/50">
              {totals.upcoming.slice(0, 12).map((u, i) => (
                <li key={`${u.dateISO}-${u.name}-${i}`} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{u.name}</div>
                    <div className="text-xs text-muted-foreground">{formatShortDate(u.dateISO)}</div>
                  </div>
                  <div className="text-sm tabular-nums">{formatMYR(u.amountMYR)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">No upcoming charges.</p>
          )}
        </section>
      </div>

      {totals.cancellationSavingsMYR > 0 ? (
        <SavingsCard monthly={totals.cancellationSavingsMYR} yearly={totals.cancellationSavingsYearlyMYR} />
      ) : null}
    </>
  );
}

/* ------------------------------ Yearly detail ----------------------------- */

function YearlyDetail({ totals }: { totals: YearlyReportTotalsV1 }) {
  const maxBucket = Math.max(1, ...totals.monthlyBuckets.map((b) => b.totalMYR));
  const prevYear = String(Number(totals.yearKey) - 1);
  return (
    <>
      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
            <TrendingUp className="size-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Spent this year (MYR)
            </div>
            <div className="text-3xl font-semibold tracking-tight">
              {formatCurrency(totals.totalMYR, HOME_CURRENCY)}
            </div>
            <div className="mt-0.5 text-xs">
              <span className={`font-semibold ${deltaColor(totals.deltaPct)}`}>
                {deltaText(totals.deltaPct)}
              </span>
              <span className="ml-1.5 text-muted-foreground">vs {prevYear}</span>
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="avg / month" value={formatMYR(roundMoney(totals.totalMYR / 12))} />
          <StatTile label="categories" value={String(totals.categories.length)} />
          <StatTile label="top subs" value={String(totals.topSubscriptions.length)} />
          <StatTile label="charges" value={String(totals.monthlyBuckets.reduce((s, b) => s + (b.totalMYR > 0 ? 1 : 0), 0))} />
        </div>
      </section>

      {/* Monthly trend (CSS bars, no chart lib) */}
      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
        <h2 className="mb-4 text-sm font-medium">Monthly spend</h2>
        <div className="flex h-44 items-end justify-between gap-2">
          {totals.monthlyBuckets.map((b) => {
            const heightPct = Math.max(4, Math.round((b.totalMYR / maxBucket) * 100));
            const [, mm] = b.monthKey.split("-");
            const label = new Date(Number(totals.yearKey), Number(mm) - 1, 1).toLocaleDateString("en-GB", { month: "short" });
            return (
              <div key={b.monthKey} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
                <div className="text-[10px] text-muted-foreground">
                  {b.totalMYR > 0 ? formatMYR(b.totalMYR).replace("RM ", "") : ""}
                </div>
                <div className="flex w-full flex-1 items-end">
                  <div className="w-full rounded-md bg-primary/50" style={{ height: `${heightPct}%` }} />
                </div>
                <div className="text-[11px] text-muted-foreground">{label}</div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium">By category</h2>
          <span className="text-xs text-muted-foreground">Spent this month (MYR)</span>
        </div>
        {totals.categories.length === 0 ? (
          <p className="text-xs text-muted-foreground">No spend this year.</p>
        ) : (
          <ReportCategoryChart categories={totals.categories} centerLabel="spent" centerValue={totals.totalMYR} />
        )}
      </section>

      {totals.topSubscriptions.length > 0 ? (
        <section className="rounded-2xl border border-border/60 bg-surface/40 p-6 print:break-inside-avoid">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <Trophy className="size-4 text-primary" /> Top subscriptions
          </h2>
          <ol className="flex flex-col gap-2">
            {totals.topSubscriptions.map((s, i) => (
              <li key={`${s.name}-${i}`} className="flex items-center gap-3 text-sm">
                <span className="grid size-6 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="text-right font-medium">{formatMYR(s.totalMYR)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {totals.cancellationSavingsMYR > 0 ? <SavingsCard yearly={totals.cancellationSavingsMYR} /> : null}
    </>
  );
}

function SavingsCard({ monthly, yearly }: { monthly?: number; yearly?: number }) {
  const amount = yearly ?? monthly ?? 0;
  // Prefer the snapshot's pre-rounded annualized figure; fall back to a derived
  // value for older/sample rows that predate cancellationSavingsYearlyMYR.
  const yearlyFigure = yearly ?? (monthly != null ? roundMoney(monthly * 12) : null);
  return (
    <section className="flex items-center gap-3 rounded-2xl border border-success/30 bg-success/6 p-6">
      <div className="grid size-10 place-items-center rounded-xl bg-success/15 text-success">
        <PiggyBank className="size-5" />
      </div>
      <div>
        <div className="text-sm font-medium">
          You saved {formatMYR(amount)}
          {yearly ? " this year" : "/month"} from cancelled subscriptions.
        </div>
        {!yearly && yearlyFigure != null ? (
          <div className="text-xs text-muted-foreground">
            That&apos;s {formatMYR(yearlyFigure)} a year.
          </div>
        ) : null}
      </div>
    </section>
  );
}
