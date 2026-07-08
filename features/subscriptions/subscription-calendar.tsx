"use client";

import { useMemo, useState } from "react";
import { addMonths } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Subscription } from "@/types/subscription";
import { CATEGORY_META } from "@/lib/constants";
import { chargeDatesInRange, isActive } from "@/lib/domain/subscription";
import { calendarGrid, monthBounds, WEEKDAY_LABELS } from "@/lib/domain/calendar";
import { formatCurrency, roundMoney } from "@/lib/domain/money";
import { myrEquivalentOf, toMYR } from "@/lib/domain/fx";
import { formatLongDate, formatMonthYear, toISODate } from "@/lib/domain/dates";
import { cn } from "@/lib/utils";
import { Dialog } from "@/components/ui/dialog";
import { SubscriptionIcon } from "./subscription-icon";
import {
  AddSubscriptionButton,
  EditSubscriptionButton,
} from "./subscription-dialogs";

interface DayCharge {
  sub: Subscription;
  /** True when this charge is the trial converting to paid (first paid date). */
  isTrialConversion: boolean;
}

const MAX_ICONS_PER_CELL = 3;

/**
 * Monthly calendar of upcoming charges. `todayISO` is passed from the server so
 * the initial render is deterministic (no `new Date()` in client state → no
 * SSR/hydration mismatch). Charge dates for any month are derived client-side
 * via the renewal engine. Each occupied day shows the provider's brand icon
 * (not just a category dot), and clicking any day opens a modal listing that
 * day's charges with an MYR total.
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
  const [modalISO, setModalISO] = useState<string | null>(null);

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

  const openDay = (iso: string) => {
    setSelectedISO(iso);
    setModalISO(iso);
  };

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

  const modalCharges = modalISO ? chargesByDay.get(modalISO) ?? [] : [];

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
              onClick={() => openDay(cell.iso)}
              aria-label={
                formatLongDate(cell.iso) +
                (charges.length
                  ? `, ${charges.length} ${charges.length === 1 ? "charge" : "charges"}`
                  : ", no charges") +
                (hasTrial ? ", trial converts" : "")
              }
              className={cn(
                "group relative flex min-h-16 flex-col gap-1 rounded-xl border p-1.5 text-left transition-colors sm:min-h-24",
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
                <div className="mt-auto flex items-center">
                  {charges.slice(0, MAX_ICONS_PER_CELL).map((c, i) => (
                    <SubscriptionIcon
                      key={c.sub.id + "-" + i}
                      sub={c.sub}
                      size="sm"
                      className="ring-0 transition-transform duration-150 ease-out group-hover:-translate-y-0.5"
                      style={{
                        // Leftmost icon sits on top of the stack (matches the
                        // reference overlap), each later icon tucks behind.
                        zIndex: MAX_ICONS_PER_CELL - i,
                        marginLeft: i === 0 ? 0 : -10,
                        // A crisp high-contrast separator ring (dark in light
                        // mode, white in dark mode via light-dark()) so each
                        // icon reads as a distinct overlapping avatar, plus a
                        // soft drop shadow for depth. This is what makes the
                        // stack visibly "premium" instead of blending into the
                        // cell — the earlier bg-tinted ring was nearly invisible.
                        boxShadow:
                          "0 1px 2px rgba(0,0,0,0.3), 0 0 0 1.5px light-dark(rgba(0,0,0,0.82), rgba(255,255,255,0.95))",
                      }}
                    />
                  ))}
                  {charges.length > MAX_ICONS_PER_CELL && (
                    <span
                      className="ml-1.5 rounded-full px-1.5 py-px text-[9px] font-semibold leading-none text-muted-foreground"
                      style={{
                        zIndex: 1,
                        backgroundColor: "color-mix(in oklch, var(--surface) 70%, transparent)",
                        boxShadow: "0 0 0 1px var(--border)",
                      }}
                    >
                      +{charges.length - MAX_ICONS_PER_CELL}
                    </span>
                  )}
                </div>
              )}
              {hasTrial && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-warning"
                />
              )}
            </button>
          );
        })}
      </div>

      <p className="text-center text-[11px] text-muted-foreground/70">
        Tap a day to see its charges · totals in MYR (RM)
      </p>

      <Dialog
        open={modalISO !== null}
        onClose={() => setModalISO(null)}
        title={modalISO ? formatLongDate(modalISO) : ""}
      >
        <DayCharges iso={modalISO ?? todayISO} charges={modalCharges} />
        <div className="mt-4 flex justify-end border-t border-border/60 pt-4">
          <AddSubscriptionButton
            size="sm"
            label="Add subscription"
            defaultStartDate={modalISO ?? todayISO}
          />
        </div>
      </Dialog>
    </div>
  );
}

function DayCharges({ iso, charges }: { iso: string; charges: DayCharge[] }) {
  // Total is always MYR: convert every charge (whatever its currency) to MYR,
  // sum at full precision, round once. Each line keeps its original currency
  // with an "≈ RM" hint for foreign amounts.
  const totalMYR = roundMoney(
    charges.reduce((sum, c) => sum + toMYR(c.sub.amount, c.sub.currency), 0),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {charges.length === 0
            ? "No charges on this date."
            : `${charges.length} ${charges.length === 1 ? "charge" : "charges"}`}
        </div>
        {charges.length > 0 && (
          <div className="text-right">
            <div className="text-[11px] text-muted-foreground">Total</div>
            <div className="text-sm font-semibold">{formatCurrency(totalMYR, "MYR")}</div>
          </div>
        )}
      </div>

      {charges.length > 0 && (
        <ul className="flex flex-col divide-y divide-border/50">
          {charges.map((c, i) => {
            const myr = myrEquivalentOf(c.sub.amount, c.sub.currency);
            return (
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
                  <div className="text-right">
                    <div className="text-sm font-medium">
                      {formatCurrency(c.sub.amount, c.sub.currency)}
                    </div>
                    {myr && <div className="text-[11px] text-muted-foreground">≈ {myr}</div>}
                  </div>
                  <EditSubscriptionButton
                    subscription={c.sub}
                    className="h-7 px-2.5 text-xs"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
