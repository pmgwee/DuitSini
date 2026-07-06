"use client";

import { useMemo } from "react";
import { addDays } from "date-fns";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { TrendingUp, CalendarClock, Sparkles, PiggyBank } from "lucide-react";
import type { Subscription } from "@/types/subscription";
import { CATEGORIES, CATEGORY_COLOR, CATEGORY_META } from "@/lib/constants";
import {
  chargeDatesInRange,
  isActive,
  isTrialConvertingWithin,
  monthlyAmount,
  yearlyAmount,
} from "@/lib/domain/subscription";
import { monthBounds } from "@/lib/domain/calendar";
import { formatCompactCurrency, formatCurrency, roundMoney } from "@/lib/domain/money";
import { toISODate } from "@/lib/domain/dates";
import { SubscriptionIcon } from "./subscription-icon";

/**
 * Page 1 / Tab 2: spending analytics. Monthly/yearly/average, upcoming 30-day
 * charges, a category ring, a 6-month cash-flow trend, trial conversions, and
 * savings from cancelled subscriptions. All derived from the subscription list.
 */
export function SubscriptionStatistics({ subscriptions }: { subscriptions: Subscription[] }) {
  const currency = useMemo(
    () => subscriptions.find((s) => !s.isCancelled)?.currency ?? subscriptions[0]?.currency ?? "USD",
    [subscriptions],
  );

  const stats = useMemo(() => {
    const active = subscriptions.filter(isActive);
    const cancelled = subscriptions.filter((s) => s.isCancelled);

    const monthly = roundMoney(active.reduce((sum, s) => sum + monthlyAmount(s), 0));
    const yearly = roundMoney(active.reduce((sum, s) => sum + yearlyAmount(s), 0));

    const todayISO = toISODate(new Date());
    const horizonEnd = toISODate(addDays(new Date(), 30));
    const upcoming = active.flatMap((sub) =>
      chargeDatesInRange(sub, todayISO, horizonEnd).map((iso) => ({ sub, iso })),
    );
    const upcomingTotal = roundMoney(upcoming.reduce((sum, x) => sum + x.sub.amount, 0));

    const trialsConverting = active.filter((s) => isTrialConvertingWithin(s, 30));
    const savedMonthly = roundMoney(cancelled.reduce((sum, s) => sum + monthlyAmount(s), 0));

    const ring = CATEGORIES.map((category) => {
      const value = roundMoney(
        active
          .filter((s) => s.category === category)
          .reduce((sum, s) => sum + monthlyAmount(s), 0),
      );
      return { category, label: CATEGORY_META[category].label, color: CATEGORY_COLOR[category], value };
    }).filter((r) => r.value > 0);

    const now = new Date();
    const trend = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
      const { startISO, endISO } = monthBounds(d.getFullYear(), d.getMonth());
      const total = roundMoney(
        active.reduce(
          (sum, sub) =>
            sum + chargeDatesInRange(sub, startISO, endISO).reduce((a) => a + sub.amount, 0),
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
      upcomingCount: upcoming.length,
      upcomingTotal,
      trialsConverting,
      savedMonthly,
      ring,
      trend,
    };
  }, [subscriptions]);

  return (
    <div className="flex flex-col gap-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={TrendingUp}
          label="Monthly equivalent"
          value={formatCurrency(stats.monthly, currency)}
          hint="normalized across cycles"
        />
        <StatCard
          icon={CalendarClock}
          label="Yearly equivalent"
          value={formatCurrency(stats.yearly, currency)}
          hint={`${stats.active.length} active`}
        />
        <StatCard
          icon={Sparkles}
          label="Next 30 days"
          value={formatCurrency(stats.upcomingTotal, currency)}
          hint={`${stats.upcomingCount} ${stats.upcomingCount === 1 ? "charge" : "charges"}`}
        />
        <StatCard
          icon={PiggyBank}
          label="Saved / month"
          value={formatCurrency(stats.savedMonthly, currency)}
          hint="from cancelled"
          accent="success"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Category ring */}
        <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium">By category</h3>
            <span className="text-xs text-muted-foreground">monthly equivalent</span>
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
                    >
                      {stats.ring.map((r) => (
                        <Cell key={r.category} fill={r.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      content={({ active: a, payload }) =>
                        a && payload && payload.length ? (
                          <TooltipBody
                            label={String(payload[0].name)}
                            value={formatCurrency(Number(payload[0].value), currency)}
                          />
                        ) : null
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 grid place-items-center">
                  <div className="text-center">
                    <div className="text-[11px] text-muted-foreground">/ month</div>
                    <div className="text-sm font-semibold">
                      {formatCompactCurrency(stats.monthly, currency)}
                    </div>
                  </div>
                </div>
              </div>
              <ul className="flex flex-1 flex-col gap-1.5">
                {stats.ring
                  .slice()
                  .sort((a, b) => b.value - a.value)
                  .map((r) => (
                    <li key={r.category} className="flex items-center gap-2 text-xs">
                      <span
                        className="size-2 rounded-full"
                        style={{ background: r.color }}
                      />
                      <span className="flex-1 text-muted-foreground">{r.label}</span>
                      <span className="font-medium">
                        {formatCurrency(r.value, currency)}
                      </span>
                    </li>
                  ))}
              </ul>
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
              <BarTrend data={stats.trend} currency={currency} />
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
            {stats.trialsConverting.map((sub) => (
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
                <div className="text-sm font-medium">{formatCurrency(sub.amount, sub.currency)}</div>
              </li>
            ))}
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

function TooltipBody({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-xs shadow-lg">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
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
 */
function BarTrend({
  data,
  currency,
}: {
  data: { label: string; total: number; isCurrent: boolean }[];
  currency: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.total));
  return (
    <div className="flex h-full items-end justify-between gap-2">
      {data.map((d) => {
        const heightPct = Math.max(4, Math.round((d.total / max) * 100));
        return (
          <div key={d.label} className="flex h-full flex-1 flex-col items-center justify-end gap-2">
            <div className="text-[10px] text-muted-foreground">
              {d.total > 0 ? formatCompactCurrency(d.total, currency) : ""}
            </div>
            <div className="flex w-full flex-1 items-end">
              <div
                className={`w-full rounded-md transition-all ${
                  d.isCurrent ? "bg-primary/70" : "bg-primary/25"
                }`}
                style={{ height: `${heightPct}%` }}
                title={`${d.label}: ${formatCurrency(d.total, currency)}`}
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
