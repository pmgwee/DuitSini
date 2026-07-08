"use client";

import type { Subscription } from "@/types/subscription";
import { CATEGORIES, CATEGORY_META } from "@/lib/constants";
import { isActive, monthlyAmount } from "@/lib/domain/subscription";
import { formatCompactCurrency, roundMoney } from "@/lib/domain/money";
import { HOME_CURRENCY, toMYR } from "@/lib/domain/fx";
import { useMusicPlayer } from "@/features/dashboard/music/player-context";
import { cn } from "@/lib/utils";

/**
 * The persistent overview dock shown beneath both tabs. Aggregates active
 * subscriptions by category (count + normalized monthly cost). Because the app
 * is MYR-home, every figure — per-category and the global total — is converted
 * to MYR and shown in ringgit, regardless of how many currencies are present.
 *
 * Positioning: `sticky` by default (Calendar/All) — it sits at the end of the
 * page content. When `pinned` (Statistics), it's `fixed` to the viewport bottom
 * so it stays visible while scrolling the tall charts. When the floating music
 * mini-bar is showing (music queued, and this page is never the dashboard), the
 * dock lifts itself above the bar so the two stack instead of overlapping.
 */
export function CategoryDock({
  subscriptions,
  pinned = false,
}: {
  subscriptions: Subscription[];
  pinned?: boolean;
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

  const totalMonthly = roundMoney(
    active.reduce((sum, s) => sum + toMYR(monthlyAmount(s), s.currency), 0),
  );

  const card = (
    <div className="glass card-elevated rounded-2xl border border-border/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Overview by category
        </span>
        <span className="text-xs text-muted-foreground">
          {active.length} active · {formatCompactCurrency(totalMonthly, HOME_CURRENCY)}/mo
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
                · {formatCompactCurrency(r.monthly, HOME_CURRENCY)}
              </span>
            </span>
          ))
        )}
      </div>
    </div>
  );

  return (
    <div
      className={cn(
        // Fixed (Statistics) pins to the viewport bottom and clears the sidebar;
        // sticky (Calendar/All) flows at the end of the content as before.
        pinned ? "fixed left-0 right-0 lg:left-62" : "sticky",
        "z-30 transition-[bottom] duration-300",
        // Lift above the floating music bar when it's showing so they stack.
        musicActive ? "bottom-36 lg:bottom-24" : "bottom-20 lg:bottom-6",
      )}
    >
      {pinned ? (
        // Re-constrain to the content column (fixed is viewport-relative).
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">{card}</div>
      ) : (
        card
      )}
    </div>
  );
}
