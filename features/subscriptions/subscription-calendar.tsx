"use client";

import { useMemo, useState } from "react";
import { addMonths } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Subscription } from "@/types/subscription";
import { CATEGORY_META } from "@/lib/constants";
import { chargeDatesInRange, isActive } from "@/lib/domain/subscription";
import { calendarGrid, monthBounds, WEEKDAY_LABELS } from "@/lib/domain/calendar";
import { formatCurrency, roundMoney } from "@/lib/domain/money";
import { formatLongDate, formatMonthYear, toISODate } from "@/lib/domain/dates";
import { cn } from "@/lib/utils";
import { SubscriptionIcon } from "./subscription-icon";
import { EditSubscriptionButton } from "./subscription-dialogs";

interface DayCharge {
  sub: Subscription;
  /** True when this charge is the trial converting to paid (first paid date). */
  isTrialConversion: boolean;
}

/**
 * Monthly calendar of upcoming charges. `todayISO` is passed from the server so
 * the initial render is deterministic (no `new Date()` in client state → no
 * SSR/hydration mismatch when the server and browser differ on timezone/date).
 * Charge dates for any month are derived client-side via the renewal engine.
 */
export function SubscriptionCalendar({
  subscriptions,
  todayISO,
}: {
  subscriptions: Subscription[];
  todayISO: string;
}) {
  const [cursor, setCursor] = useState(() => {
    const [year, month] = todayISO.split("-").map(Number);
    return new Date(year, month - 1, 1);
  });
  const [selectedISO, setSelectedISO] = useState<string>(todayISO);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const grid = useMemo(() => calendarGrid(year, month, todayISO), [year, month, todayISO]);

  // Charges across the full 42-cell grid span (so spillover days from adjacent
  // months show their charges too), not just the focused month.
  const chargesByDay = useMemo(() => {
    const firstISO = grid[0].iso;
    const lastISO = grid[grid.length - 1].iso;
    const map = new Map<string, DayCharge[]>();
    for (const sub of subscriptions) {
      if (!isActive(sub)) continue;
      for (const iso of chargeDatesInRange(sub, firstISO, lastISO)) {
        const entry: DayCharge = {
          sub,
          isTrialConversion: sub.isTrial && sub.freeTrialEndAt === iso,
        };
        const list = map.get(iso);
        if (list) list.push(entry);
        else map.set(iso, [entry]);
      }
    }
    return map;
  }, [subscriptions, grid]);

  // The headline count is for the focused month only.
  const monthChargeCount = useMemo(() => {
    const { startISO, endISO } = monthBounds(year, month);
    let n = 0;
    for (const sub of subscriptions) {
      if (!isActive(sub)) continue;
      n += chargeDatesInRange(sub, startISO, endISO).length;
    }
    return n;
  }, [subscriptions, year, month]);

  const selectedCharges = chargesByDay.get(selectedISO) ?? [];

  const shiftMonth = (delta: number) => {
    const next = addMonths(cursor, delta);
    const first = new Date(next.getFullYear(), next.getMonth(), 1);
    setCursor(first);
    setSelectedISO(toISODate(first));
  };

  const goToday = () => {
    const [y, m] = todayISO.split("-").map(Number);
    setCursor(new Date(y, m - 1, 1));
    setSelectedISO(todayISO);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{formatMonthYear(cursor)}</h2>
          <p className="text-xs text-muted-foreground">
            {monthChargeCount} {monthChargeCount === 1 ? "charge" : "charges"} this month
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
            className="grid size-9 place-items-center rounded-xl border border-border/60 bg-surface/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            onClick={goToday}
            className="rounded-xl border border-border/60 bg-surface/50 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
            className="grid size-9 place-items-center rounded-xl border border-border/60 bg-surface/50 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {/* Weekday labels */}
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="pb-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{label[0]}</span>
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-1.5">
        {grid.map((cell) => {
          const charges = chargesByDay.get(cell.iso) ?? [];
          const isSelected = cell.iso === selectedISO;
          const hasTrial = charges.some((c) => c.isTrialConversion);
          return (
            <button
              key={cell.iso}
              type="button"
              onClick={() => setSelectedISO(cell.iso)}
              aria-label={
                formatLongDate(cell.iso) +
                (charges.length
                  ? `, ${charges.length} ${charges.length === 1 ? "charge" : "charges"}`
                  : ", no charges") +
                (hasTrial ? ", trial converts" : "")
              }
              className={cn(
                "relative flex min-h-16 flex-col gap-1 rounded-xl border p-1.5 text-left transition-colors sm:min-h-23",
                cell.inMonth ? "bg-surface/40" : "bg-transparent opacity-40",
                isSelected
                  ? "border-primary/60 ring-1 ring-primary/40"
                  : "border-border/50 hover:border-border",
              )}
            >
              <span
                className={cn(
                  "text-xs font-medium",
                  cell.isToday &&
                    "grid size-5 place-items-center rounded-full bg-primary text-primary-foreground",
                  !cell.isToday && "text-muted-foreground",
                )}
              >
                {cell.day}
              </span>
              {charges.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {charges.slice(0, 4).map((c, i) => (
                    <span
                      key={c.sub.id + "-" + i}
                      className={cn("size-1.5 rounded-full", c.isTrialConversion && "animate-pulse")}
                      style={{
                        background: c.isTrialConversion
                          ? "var(--warning)"
                          : CATEGORY_META[c.sub.category].colorVar,
                      }}
                    />
                  ))}
                </div>
              )}
              {charges.length > 4 && (
                <span className="text-[9px] font-medium text-muted-foreground">
                  +{charges.length - 4}
                </span>
              )}
              {hasTrial && (
                <span
                  aria-hidden="true"
                  className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-warning"
                />
              )}
            </button>
          );
        })}
      </div>

      <DayDetail iso={selectedISO} charges={selectedCharges} />
    </div>
  );
}

function DayDetail({ iso, charges }: { iso: string; charges: DayCharge[] }) {
  // Only show a combined total when every charge shares one currency; otherwise
  // the per-line items (each in their own currency) are the honest view.
  const currencies = new Set(charges.map((c) => c.sub.currency));
  const showTotal = charges.length > 0 && currencies.size === 1;
  const total = roundMoney(charges.reduce((sum, c) => sum + c.sub.amount, 0));
  const currency = charges[0]?.sub.currency ?? "USD";

  return (
    <div className="rounded-2xl border border-border/60 bg-surface/40 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{formatLongDate(iso)}</div>
          <div className="text-xs text-muted-foreground">
            {charges.length === 0
              ? "No charges"
              : `${charges.length} ${charges.length === 1 ? "charge" : "charges"}`}
          </div>
        </div>
        {showTotal && (
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="text-sm font-semibold">{formatCurrency(total, currency)}</div>
          </div>
        )}
      </div>

      {charges.length > 0 && (
        <ul className="mt-3 flex flex-col divide-y divide-border/50">
          {charges.map((c, i) => (
            <li
              key={c.sub.id + "-" + i}
              className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
            >
              <SubscriptionIcon sub={c.sub} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.sub.name}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{CATEGORY_META[c.sub.category].label}</span>
                  {c.isTrialConversion && (
                    <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      Trial converts
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">
                  {formatCurrency(c.sub.amount, c.sub.currency)}
                </div>
                <EditSubscriptionButton
                  subscription={c.sub}
                  className="h-7 px-2.5 text-xs"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
