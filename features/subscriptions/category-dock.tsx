import type { Subscription } from "@/types/subscription";
import { CATEGORIES, CATEGORY_META } from "@/lib/constants";
import { isActive, monthlyAmount } from "@/lib/domain/subscription";
import { formatCompactCurrency, formatCurrency, roundMoney } from "@/lib/domain/money";

/**
 * The persistent overview dock shown beneath both tabs. Aggregates active
 * subscriptions by category (count + normalized monthly cost) from real data.
 * Each row uses its own currency; the global total is only shown when every
 * active subscription shares one currency (no FX layer — sums across unlike
 * currencies would be misleading).
 */
export function CategoryDock({ subscriptions }: { subscriptions: Subscription[] }) {
  const active = subscriptions.filter(isActive);

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
    <div className="sticky bottom-20 z-30 lg:bottom-6">
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
