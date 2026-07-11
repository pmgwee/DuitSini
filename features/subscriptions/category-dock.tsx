"use client";

import type { ReactNode } from "react";
import type { Subscription } from "@/types/subscription";
import { CATEGORIES, CATEGORY_META } from "@/lib/constants";
import {
  isActive,
  monthlyAmount,
  subscriptionsChargingInRange,
} from "@/lib/domain/subscription";
import { formatCompactCurrency, formatCurrency, roundMoney } from "@/lib/domain/money";
import { HOME_CURRENCY, toMYR } from "@/lib/domain/fx";
import { monthBounds } from "@/lib/domain/calendar";
import { useMusicPlayer } from "@/features/dashboard/music/player-context";
import { cn } from "@/lib/utils";

/**
 * The persistent overview dock shown beneath the Calendar and All tabs. It
 * surfaces two differentiated cost figures plus a per-category breakdown.
 *
 *   - "This month" — the ACTUAL count + MYR total of charges landing in the
 *     current calendar month (a sub may charge more than once; an annual sub
 *     only counts in the month it renews). Derived from the renewal engine.
 *   - "Recurring" — the NORMALIZED monthly cost (any billing cycle smoothed to
 *     a /mo figure, e.g. an annual plan shown as 1/12 of its price each month).
 *
 * The two diverge whenever a sub isn't monthly (annual/quarterly/weekly), so
 * both are shown side by side. The app is MYR-home: every figure is converted
 * to ringgit. Sticky; lifts above the floating music bar when it's active.
 */
export function CategoryDock({
  subscriptions,
  todayISO,
}: {
  subscriptions: Subscription[];
  todayISO: string;
}) {
  const active = subscriptions.filter(isActive);
  const musicActive = useMusicPlayer().queueLength > 0;

  const rows = CATEGORIES.map((category) => {
    const subs = active.filter((s) => s.category === category);
    const monthly = roundMoney(
      subs.reduce((sum, s) => sum + toMYR(monthlyAmount(s), s.currency), 0),
    );
    return {
      category,
      ...CATEGORY_META[category],
      count: subs.length,
      monthly,
    };
  }).filter((r) => r.count > 0);

  // Recurring: normalized monthly cost of every active subscription.
  const totalMonthly = roundMoney(
    active.reduce((sum, s) => sum + toMYR(monthlyAmount(s), s.currency), 0),
  );

  // This month (actual): distinct active subs charging in the current calendar
  // month, and the real MYR total of those charges (a sub can charge >1×).
  const [year, month] = todayISO.split("-").map(Number);
  const { startISO, endISO } = monthBounds(year, month - 1);
  const monthItems = subscriptionsChargingInRange(subscriptions, startISO, endISO);
  const monthSubCount = monthItems.length;
  const monthTotalMYR = roundMoney(
    monthItems.reduce(
      (sum, it) => sum + toMYR(it.sub.amount, it.sub.currency) * it.dates.length,
      0,
    ),
  );

  return (
    <div
      className={cn(
        "sticky z-30 transition-[bottom] duration-300",
        // Lift above the floating music bar when it's showing so they stack.
        musicActive ? "bottom-36 lg:bottom-24" : "bottom-20 lg:bottom-6",
      )}
    >
      <div className="glass card-elevated rounded-2xl border border-border/60 p-4">
        {/* Two differentiated cost figures */}
        <div className="grid grid-cols-2 gap-2.5">
          <Stat label="Spent this month (MYR)" hint="ACTUAL CHARGES">
            <div className="text-sm font-semibold tabular-nums">
              {monthSubCount} {monthSubCount === 1 ? "subscription" : "subscriptions"}
            </div>
            <div className="text-xs text-muted-foreground">
              {formatCurrency(monthTotalMYR, HOME_CURRENCY)}
            </div>
          </Stat>
          <Stat label="MONTHLY Recurring (MYR)" hint="ALL BILLING CYCLE">
            <div className="text-sm font-semibold tabular-nums">
              {active.length} subscriptions
            </div>
            <div className="text-xs text-muted-foreground">
              {formatCompactCurrency(totalMonthly, HOME_CURRENCY)}/mo
            </div>
          </Stat>
        </div>

        {/* Per-category breakdown */}
        <div className="mt-3 flex flex-wrap gap-2">
          {rows.length === 0 ? (
            <span className="text-xs text-muted-foreground">No active subscriptions yet.</span>
          ) : (
            rows.map((r) => (
              <span
                key={r.category}
                className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-surface/60 px-3 py-1.5 text-xs"
              >
                <span className="size-2 rounded-full" style={{ background: r.colorVar }} />
                {r.label}
                <span className="text-muted-foreground">{r.count}</span>
                <span className="text-muted-foreground/70">
                  · {formatCompactCurrency(r.monthly, HOME_CURRENCY)}
                </span>
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-surface/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="text-[9px] text-muted-foreground/60">{hint}</span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
