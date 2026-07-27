"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Subscription, SubscriptionStatus } from "@/types/subscription";
import {
  getNextChargeDate,
  getStatus,
  grossMonthlyCost,
} from "@/lib/domain/subscription";
import { formatCurrency, roundMoney } from "@/lib/domain/money";
import { HOME_CURRENCY, myrEquivalentOf, toMYR } from "@/lib/domain/fx";
import { formatLongDate, formatRelativeDay, toISODate } from "@/lib/domain/dates";
import { cn } from "@/lib/utils";
import { SubscriptionIcon } from "./subscription-icon";
import { EditSubscriptionButton } from "./subscription-dialogs";
import { PaymentMethodBadge } from "./payment-method-badge";

const STATUS_META: Record<
  SubscriptionStatus,
  { label: string; className: string }
> = {
  active: {
    label: "Active",
    className: "bg-success/15 text-success ring-1 ring-success/25",
  },
  trial: {
    label: "Trial",
    className: "bg-warning/15 text-warning ring-1 ring-warning/25",
  },
  paused: {
    label: "Paused",
    className: "bg-muted text-muted-foreground ring-1 ring-border/60",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-danger/10 text-danger ring-1 ring-danger/25",
  },
};

const STATUS_ORDER: Record<SubscriptionStatus, number> = {
  active: 0,
  trial: 1,
  paused: 2,
  cancelled: 3,
};

/**
 * The full, searchable list of every subscription regardless of status or
 * whether it has a charge in the visible calendar window. This is the only
 * surface from which paused, cancelled, or out-of-window annual subscriptions
 * can be reached to edit / resume / restore / delete.
 *
 * Monthly cost is the nominal (gross) figure in MYR so a paused or cancelled
 * sub still shows what it would cost; the status badge conveys that it isn't
 * currently being charged.
 */
export function SubscriptionList({ subscriptions }: { subscriptions: Subscription[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? subscriptions.filter((s) =>
          [s.name, s.provider, s.category, s.planType]
            .filter(Boolean)
            .some((v) => (v as string).toLowerCase().includes(q)),
        )
      : subscriptions;
    return [...matches].sort((a, b) => {
      const so = STATUS_ORDER[getStatus(a)] - STATUS_ORDER[getStatus(b)];
      if (so !== 0) return so;
      return (a.nextRenewalAt || "").localeCompare(b.nextRenewalAt || "");
    });
  }, [subscriptions, query]);

  const activeMonthlyMYR = useMemo(
    () =>
      roundMoney(
        subscriptions
          .filter((s) => getStatus(s) === "active" || getStatus(s) === "trial")
          .reduce((sum, s) => sum + toMYR(grossMonthlyCost(s), s.currency), 0),
      ),
    [subscriptions],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {subscriptions.length} {subscriptions.length === 1 ? "subscription" : "subscriptions"} ·{" "}
          {formatCurrency(activeMonthlyMYR, HOME_CURRENCY)}/mo active
        </p>
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search subscriptions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, provider…"
            className="h-10 w-full rounded-xl border border-border/60 bg-input/50 pl-9 pr-3 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-border/60 bg-surface/40 px-4 py-12 text-center text-sm text-muted-foreground">
          {subscriptions.length === 0
            ? "No subscriptions yet — add your first one."
            : "No subscriptions match your search."}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border/50 rounded-2xl border border-border/60 bg-surface/40">
          {filtered.map((sub) => (
            <SubscriptionRow key={sub.id} sub={sub} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function SubscriptionRow({ sub }: { sub: Subscription }) {
  const status = getStatus(sub);
  const meta = STATUS_META[status];
  const monthlyMYR = roundMoney(toMYR(grossMonthlyCost(sub), sub.currency));
  const myr = myrEquivalentOf(sub.amount, sub.currency);
  const next = getNextChargeDate(sub, toISODate(new Date()));

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <SubscriptionIcon sub={sub} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{sub.name}</span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              meta.className,
            )}
          >
            {meta.label}
          </span>
          {sub.reminderOffsetsDays != null ? (
            <span className="shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Custom schedule
            </span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {sub.provider && sub.provider !== sub.name ? `${sub.provider} · ` : ""}
          {formatCurrency(sub.amount, sub.currency)}
          {sub.billingCycle !== "monthly" && sub.billingCycle !== "one_off"
            ? ` / ${sub.billingCycle}`
            : sub.billingCycle === "one_off"
              ? " · one-off"
              : "/mo"}
          {myr && <span className="text-muted-foreground/70"> (≈ {myr}/charge)</span>}
        </div>
        {sub.paymentMethod ? (
          <PaymentMethodBadge method={sub.paymentMethod} className="mt-1" />
        ) : null}
      </div>
      <div className="hidden text-right sm:block">
        <div className="text-xs text-muted-foreground">
          {next ? (formatRelativeDay(next) === "Today" ? "Today" : formatRelativeDay(next)) : "—"}
        </div>
        <div className="text-[11px] text-muted-foreground/70">
          {next ? formatLongDate(next) : "no upcoming charge"}
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-medium">{formatCurrency(monthlyMYR, HOME_CURRENCY)}</div>
        <div className="text-[11px] text-muted-foreground">/mo</div>
      </div>
      <EditSubscriptionButton subscription={sub} className="h-8 px-2.5 text-xs" />
    </li>
  );
}
