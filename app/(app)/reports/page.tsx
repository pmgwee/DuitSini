import { CalendarClock, FileText, PiggyBank, Sparkles, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { getEffectiveUserId, getSubscriptionRepository } from "@/lib/data";
import { CATEGORIES, CATEGORY_META } from "@/lib/constants";
import {
  chargeDatesInRange,
  isActive,
  isTrialConvertingWithin,
  monthlyAmount,
} from "@/lib/domain/subscription";
import { monthBounds } from "@/lib/domain/calendar";
import { formatCurrency, roundMoney } from "@/lib/domain/money";
import { formatLongDate, formatMonthYear } from "@/lib/domain/dates";
import { CATEGORY_COLOR } from "@/lib/constants";
import { PrintButton } from "@/features/reports/print-button";

interface MonthCharge {
  id: string;
  name: string;
  category: keyof typeof CATEGORY_META;
  amount: number;
  currency: string;
  iso: string;
  isTrialConversion: boolean;
}

export default async function ReportsPage() {
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  const subscriptions = await repo.list(userId);

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const { startISO, endISO } = monthBounds(year, month);

  const active = subscriptions.filter(isActive);
  const cancelled = subscriptions.filter((s) => s.isCancelled);
  const currency = active[0]?.currency ?? subscriptions[0]?.currency ?? "USD";

  // Charges landing in this month, with trial-conversion detection.
  const charges: MonthCharge[] = [];
  for (const sub of active) {
    for (const iso of chargeDatesInRange(sub, startISO, endISO)) {
      charges.push({
        id: sub.id,
        name: sub.name,
        category: sub.category,
        amount: sub.amount,
        currency: sub.currency,
        iso,
        isTrialConversion: sub.isTrial && sub.freeTrialEndAt === iso,
      });
    }
  }
  charges.sort((a, b) => a.iso.localeCompare(b.iso));

  const totalMonth = roundMoney(charges.reduce((sum, c) => sum + c.amount, 0));

  const byCategory = CATEGORIES.map((category) => {
    const subs = active.filter((s) => s.category === category);
    return {
      category,
      ...CATEGORY_META[category],
      count: subs.length,
      monthly: roundMoney(subs.reduce((sum, s) => sum + monthlyAmount(s), 0)),
    };
  }).filter((r) => r.count > 0);

  const trialsConverting = active
    .filter((s) => isTrialConvertingWithin(s, 30))
    .sort((a, b) => (a.freeTrialEndAt ?? "").localeCompare(b.freeTrialEndAt ?? ""));
  const mostExpensive = [...active].sort((a, b) => b.amount - a.amount).slice(0, 5);
  const savings = roundMoney(cancelled.reduce((sum, s) => sum + monthlyAmount(s), 0));

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 print:max-w-none">
      <div className="print:hidden">
        <PageHeader
          title="Monthly report"
          description={`${formatMonthYear(new Date(year, month, 1))} · generated ${formatLongDate(
            `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`,
          )}`}
          actions={<PrintButton />}
        />
      </div>

      {/* Print-only header */}
      <div className="hidden print:block">
        <h1 className="text-2xl font-semibold">Subscription Agent · Monthly Report</h1>
        <p className="text-muted-foreground">{formatMonthYear(new Date(year, month, 1))}</p>
      </div>

      {/* Total */}
      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/12 text-primary">
            <TrendingUp className="size-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Expected spend this month
            </div>
            <div className="text-3xl font-semibold tracking-tight">
              {formatCurrency(totalMonth, currency)}
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Active" value={String(active.length)} />
          <Stat label="Charges" value={String(charges.length)} />
          <Stat label="Trials converting" value={String(trialsConverting.length)} />
          <Stat label="Saved / mo" value={formatCurrency(savings, currency)} accent="success" />
        </div>
      </section>

      {/* Charges by date */}
      <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <CalendarClock className="size-4 text-primary" /> Charges this month
        </h2>
        {charges.length === 0 ? (
          <EmptyState icon={FileText} title="No charges this month" description="Nothing scheduled in this month yet." />
        ) : (
          <ul className="flex flex-col divide-y divide-border/50">
            {charges.map((c, i) => (
              <li key={c.id + c.iso + i} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="size-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[c.category] }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {c.name}
                    {c.isTrialConversion ? (
                      <span className="ml-2 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                        Trial converts
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-muted-foreground">{formatLongDate(c.iso)}</div>
                </div>
                <div className="text-sm font-medium">{formatCurrency(c.amount, c.currency)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* By category */}
        <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
          <h2 className="mb-3 text-sm font-medium">By category</h2>
          {byCategory.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active subscriptions.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {byCategory.map((r) => (
                <li key={r.category} className="flex items-center gap-2 text-sm">
                  <span className="size-2 rounded-full" style={{ background: r.colorVar }} />
                  <span className="flex-1 text-muted-foreground">{r.label}</span>
                  <span className="text-muted-foreground">{r.count}</span>
                  <span className="w-24 text-right font-medium">{formatCurrency(r.monthly, currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Most expensive */}
        <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
          <h2 className="mb-3 text-sm font-medium">Most expensive</h2>
          {mostExpensive.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active subscriptions.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {mostExpensive.map((s, i) => (
                <li key={s.id} className="flex items-center gap-3 text-sm">
                  <span className="grid size-6 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <span className="font-medium">{formatCurrency(s.amount, s.currency)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* Action needed: trials converting */}
      {trialsConverting.length > 0 ? (
        <section className="rounded-2xl border border-warning/30 bg-warning/6 p-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-warning">
            <Sparkles className="size-4" /> Action needed — trials converting within 30 days
          </h2>
          <ul className="flex flex-col divide-y divide-warning/15">
            {trialsConverting.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground">
                    Converts {s.freeTrialEndAt ? formatLongDate(s.freeTrialEndAt) : "soon"}
                  </div>
                </div>
                <div className="text-sm font-medium">{formatCurrency(s.amount, s.currency)}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {savings > 0 ? (
        <section className="flex items-center gap-3 rounded-2xl border border-success/30 bg-success/6 p-6">
          <div className="grid size-10 place-items-center rounded-xl bg-success/15 text-success">
            <PiggyBank className="size-5" />
          </div>
          <div>
            <div className="text-sm font-medium">
              You&apos;re saving {formatCurrency(savings, currency)}/month from cancelled
              subscriptions.
            </div>
            <div className="text-xs text-muted-foreground">
              That&apos;s {formatCurrency(roundMoney(savings * 12), currency)} a year.
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "success";
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-surface/30 p-3">
      <div
        className={`text-lg font-semibold ${accent === "success" ? "text-success" : "text-foreground"}`}
      >
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
