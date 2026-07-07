"use client";

import type { Subscription } from "@/types/subscription";
import { CATEGORIES, CATEGORY_META } from "@/lib/constants";
import { isActive, monthlyAmount } from "@/lib/domain/subscription";
import { formatCompactCurrency, formatCurrency, roundMoney } from "@/lib/domain/money";
import { useMusicPlayer } from "@/features/dashboard/music/player-context";
import { cn } from "@/lib/utils";

/**
 * The persistent overview dock shown beneath both tabs. Aggregates active
 * subscriptions by category (count + normalized monthly cost) from real data.
 * Each row uses its own currency; the global total is only shown when every
 * active subscription shares one currency (no FX layer — sums across unlike
 * currencies would be misleading).
 *
 * When the floating music mini-bar is showing (music queued, and this page is
 * never the dashboard), the dock lifts itself above the bar so the two stack
 * instead of overlapping.
 */
export function CategoryDock({ subscriptions }: { subscriptions: Subscription[] }) {
  const active = subscriptions.filter(isActive);
  const musicActive = useMusicPlayer().queueLength > 0;

  const rows = CATEGORIES.map((category) => {
    const subs = active.filter((s) => s.category === category);
    const monthly = roundMoney(subs.reduce((sum, s) => sum + monthlyAmount(s), 0));
    return {
      category,
      ...CATEGORY_META[category],
      count: subs.length,
      monthly,
      currency: subs[0]?.currency ?? "USD",
    };
  }).filter((r) => r.count > 0);

  const currencySet = new Set(active.map((s) => s.currency));
  const sharedCurrency = currencySet.size === 1 ? [...currencySet][0] : null;
  const totalMonthly = sharedCurrency
    ? roundMoney(active.reduce((sum, s) => sum + monthlyAmount(s), 0))
    : null;

  return (
    <div
      className={cn(
        "sticky z-30 transition-[bottom] duration-300",
        // Lift above the floating music bar when it's showing so they stack.
        musicActive ? "bottom-36 lg:bottom-24" : "bottom-20 lg:bottom-6",
      )}
    >
      <div className="glass card-elevated rounded-2xl border border-border/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Overview by category
          </span>
          <span className="text-xs text-muted-foreground">
            {active.length} active
            {sharedCurrency && totalMonthly !== null
              ? ` · ${formatCurrency(totalMonthly, sharedCurrency)}/mo`
              : ""}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
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
                  · {formatCompactCurrency(r.monthly, r.currency)}
                </span>
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
