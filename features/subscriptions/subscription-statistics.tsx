"use client";

import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { TrendingUp, CalendarClock, Sparkles, PiggyBank } from "lucide-react";
import type { Subscription } from "@/types/subscription";
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_META } from "@/lib/constants";
import {
  chargeDatesInRange,
  grossMonthlyCost,
  isActive,
  isCancelled,
  isTrialConvertingWithin,
  monthlyAmount,
  yearlyAmount,
} from "@/lib/domain/subscription";
import { monthBounds } from "@/lib/domain/calendar";
import { formatCompactCurrency, formatCurrency, roundMoney } from "@/lib/domain/money";
import { HOME_CURRENCY, myrEquivalentOf, toMYR } from "@/lib/domain/fx";
import { SubscriptionIcon } from "./subscription-icon";

/**
 * Page 1 / Tab 2: spending analytics. Monthly/yearly/average, this month's
 * actual charges, a category ring, a 6-month cash-flow trend, trial conversions,
 * savings from cancelled subscriptions. All derived from the subscription list.
 *
 * Every AGGREGATE is reported in the home currency (MYR): each subscription's
 * contribution is converted to MYR at full float precision, summed, then
 * rounded once. Line items keep their original currency with an "≈ RM" hint.
 */
export function SubscriptionStatistics({ subscriptions }: { subscriptions: Subscription[] }) {
  const stats = useMemo(() => {
    const active = subscriptions.filter(isActive);
    const cancelled = subscriptions.filter(isCancelled);

    const monthly = roundMoney(
      active.reduce((sum, s) => sum + toMYR(monthlyAmount(s), s.currency), 0),
    );
    const yearly = roundMoney(
      active.reduce((sum, s) => sum + toMYR(yearlyAmount(s), s.currency), 0),
    );

    const trialsConverting = active.filter((s) => isTrialConvertingWithin(s, 30));
    // grossMonthlyCost ignores the cancelled state, so this is the would-be
    // monthly spend the user is no longer paying — the actual "saved" figure.
    // (monthlyAmount returns 0 for cancelled subs, which would always read $0.)
    const savedMonthly = roundMoney(
      cancelled.reduce((sum, s) => sum + toMYR(grossMonthlyCost(s), s.currency), 0),
    );

    const ring = CATEGORIES.map((category) => {
      const value = roundMoney(
        active
          .filter((s) => s.category === category)
          .reduce((sum, s) => sum + toMYR(monthlyAmount(s), s.currency), 0),
      );
      return { category, label: CATEGORY_META[category].label, color: CATEGORY_COLOR[category], value };
    }).filter((r) => r.value > 0);

    const now = new Date();
    // This month's ACTUAL charges — every charge landing in the current calendar
    // month, summed in MYR. Distinct from the normalized "monthly equivalent"
    // above (which smooths annual/weekly cycles to a per-month figure).
    const thisMonthBounds = monthBounds(now.getFullYear(), now.getMonth());
    // Iterate ALL subscriptions (not just active): a sub cancelled this month
    // still counts charges that landed before its cutoff. `chargeDatesInRange`
    // drops on/after-cutoff charges, so a long-cancelled sub contributes nothing.
    const thisMonthCharges = subscriptions.flatMap((sub) =>
      chargeDatesInRange(sub, thisMonthBounds.startISO, thisMonthBounds.endISO).map((iso) => ({ sub, iso })),
    );
    const thisMonthTotal = roundMoney(
      thisMonthCharges.reduce((sum, x) => sum + toMYR(x.sub.amount, x.sub.currency), 0),
    );
    const thisMonthCount = new Set(thisMonthCharges.map((x) => x.sub.id)).size;
    const trend = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      const { startISO, endISO } = monthBounds(d.getFullYear(), d.getMonth());
      const total = roundMoney(
        subscriptions.reduce(
          (sum, sub) =>
            sum + chargeDatesInRange(sub, startISO, endISO).reduce(
              (a) => a + toMYR(sub.amount, sub.currency),
              0,
            ),
          0,
        ),
      );
      return {
        label: d.toLocaleDateString(undefined, { month: "short" }),
        total,
        isCurrent: i === 5,
      };
    });

    return {
      active,
      monthly,
      yearly,
      thisMonthTotal,
      thisMonthCount,
      trialsConverting,
      savedMonthly,
      ring,
      trend,
    };
  }, [subscriptions]);

  // Donut hover — dims the non-hovered slices and surfaces a detail box beside
  // the chart (matches the report's category chart). Legend rows stay static.
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const ringTotal = stats.ring.reduce((s, r) => s + r.value, 0) || 1;
  const activeRing = activeCategory != null ? stats.ring[activeCategory] : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        All totals shown in Malaysian Ringgit (RM). Foreign-currency subscriptions are converted at
        approximate rates.
      </p>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
         <StatCard
          icon={Sparkles}
          label="Spent this month (MYR)"
          value={formatCurrency(stats.thisMonthTotal, HOME_CURRENCY)}
          hint={`${stats.thisMonthCount} ${stats.thisMonthCount === 1 ? "subscription" : "subscriptions"}`}
        />
        <StatCard
          icon={TrendingUp}
          label="Monthly Recurring (MYR)"
          value={formatCurrency(stats.monthly, HOME_CURRENCY)}
          hint={`${stats.active.length} subscriptions`}
        />
         <StatCard
          icon={CalendarClock}
          label="Yearly equivalent"
          value={formatCurrency(stats.yearly, HOME_CURRENCY)}
          hint="recurring / year"
        />
        <StatCard
          icon={PiggyBank}
          label="Saved / month"
          value={formatCurrency(stats.savedMonthly, HOME_CURRENCY)}
          hint="from cancelled"
          accent="success"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Category ring */}
        <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium">By category</h3>
            <span className="text-xs text-muted-foreground">Monthly Recurring (MYR)</span>
          </div>
          {stats.ring.length === 0 ? (
            <EmptyChart label="Add subscriptions to see the breakdown" />
          ) : (
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <div className="relative h-44 w-44 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stats.ring}
                      dataKey="value"
                      nameKey="label"
                      innerRadius={52}
                      outerRadius={80}
                      paddingAngle={2}
                      stroke="none"
                      onMouseEnter={(_, i) => setActiveCategory(i)}
                      onMouseLeave={() => setActiveCategory(null)}
                      isAnimationActive={false}
                    >
                      {stats.ring.map((r, i) => (
                        <Cell
                          key={r.category}
                          fill={r.color}
                          opacity={activeCategory == null || activeCategory === i ? 1 : 0.35}
                          style={{ transition: "opacity 120ms" }}
                        />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                  <div className="text-center">
                    <div className="text-[11px] text-muted-foreground">/ month</div>
                    <div className="text-sm font-semibold">
                      {formatCurrency(stats.monthly, HOME_CURRENCY)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex w-full flex-1 flex-col gap-2">
                {/* Hover detail — beside the chart, not over the center label. */}
                {activeRing ? (
                  <div className="rounded-lg border border-border/60 bg-surface px-3 py-2 text-xs shadow-sm">
                    <div className="flex items-center gap-2">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: activeRing.color }}
                      />
                      <span className="font-medium">{activeRing.label}</span>
                    </div>
                    <div className="mt-1 text-muted-foreground">
                      {formatCurrency(activeRing.value, HOME_CURRENCY)}
                      {" · "}
                      {Math.round((activeRing.value / ringTotal) * 100)}%
                    </div>
                  </div>
                ) : null}

                {/* Static legend — no row hover (the donut drives the only hover affordance). */}
                <ul className="flex w-full flex-1 flex-col gap-0.5">
                  {stats.ring
                    .slice()
                    .sort((a, b) => b.value - a.value)
                    .map((r) => (
                      <li
                        key={r.category}
                        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs"
                      >
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ background: r.color }}
                        />
                        <span className="flex-1 truncate text-muted-foreground">{r.label}</span>
                        <span className="w-20 text-right font-medium tabular-nums">
                          {formatCurrency(r.value, HOME_CURRENCY)}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* 6-month trend */}
        <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium">Last 6 months</h3>
            <span className="text-xs text-muted-foreground">actual charges</span>
          </div>
          {stats.active.length === 0 ? (
            <EmptyChart label="No active subscriptions to trend" />
          ) : (
            <div className="h-44 w-full">
              <BarTrend data={stats.trend} />
            </div>
          )}
        </div>
      </div>

      {/* Trial conversions */}
      {stats.trialsConverting.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning/6 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-warning">
            <Sparkles className="size-4" />
            {stats.trialsConverting.length} trial{stats.trialsConverting.length === 1 ? "" : "s"} converting within 30 days
          </div>
          <ul className="flex flex-col divide-y divide-warning/15">
            {stats.trialsConverting.map((sub) => {
              const myr = myrEquivalentOf(sub.amount, sub.currency);
              return (
                <li key={sub.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <SubscriptionIcon sub={sub} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{sub.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Converts on{" "}
                      {new Date(sub.freeTrialEndAt ?? Date.now()).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                      })}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium">{formatCurrency(sub.amount, sub.currency)}</div>
                    {myr && <div className="text-[11px] text-muted-foreground">≈ {myr}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: typeof TrendingUp;
  label: string;
  value: string;
  hint: string;
  accent?: "success";
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-surface/40 p-4">
      <div
        className={`grid size-8 place-items-center rounded-lg ${
          accent === "success" ? "bg-success/15 text-success" : "bg-primary/12 text-primary"
        }`}
      >
        <Icon className="size-4" />
      </div>
      <div className="mt-3 text-lg font-semibold tracking-tight">{value}</div>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</div>
    </div>
  );
}

function EmptyChart({ label }: { label: string }) {
  return (
    <div className="grid h-44 place-items-center text-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

/**
 * Lightweight CSS-bar "trend" — avoids pulling the full Recharts BarChart
 * (keeps the tab bundle smaller) while still reading as a calm premium chart.
 * All bars are in MYR (converted before summing), so months are comparable.
 */
function BarTrend({
  data,
}: {
  data: { label: string; total: number; isCurrent: boolean }[];
}) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div className="flex h-full items-end justify-between gap-2">
      {data.map((d) => {
        const heightPct = Math.max(4, Math.round((d.total / max) * 100));
        return (
          <div key={d.label} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
            <div className="text-[10px] text-muted-foreground">
              {d.total > 0 ? formatCompactCurrency(d.total, HOME_CURRENCY) : ""}
            </div>
            <div className="flex w-full flex-1 items-end">
              <div
                className={`w-full rounded-md transition-all ${
                  d.isCurrent ? "bg-primary/70" : "bg-primary/25"
                }`}
                style={{ height: `${heightPct}%` }}
                title={`${d.label}: ${formatCurrency(d.total, HOME_CURRENCY)}`}
              />
            </div>
            <div className={`text-[11px] ${d.isCurrent ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              {d.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}
