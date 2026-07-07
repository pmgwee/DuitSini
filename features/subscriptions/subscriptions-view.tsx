"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { BarChart3, CalendarDays, List, type LucideIcon } from "lucide-react";
import type { Subscription } from "@/types/subscription";
import { cn } from "@/lib/utils";
import { SubscriptionCalendar } from "./subscription-calendar";
import { SubscriptionList } from "./subscription-list";

// Lazy-load so Recharts is only fetched when the Statistics tab is opened.
const SubscriptionStatistics = dynamic(
  () => import("./subscription-statistics").then((m) => m.SubscriptionStatistics),
  {
    ssr: false,
    loading: () => <StatisticsSkeleton />,
  },
);

type Tab = "calendar" | "all" | "statistics";

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "all", label: "All", icon: List },
  { id: "statistics", label: "Statistics", icon: BarChart3 },
];

/**
 * Tabbed Page-1 surface: Calendar (charges by day), All (every subscription,
 * searchable, incl. paused/cancelled), and Statistics (lazy-loaded).
 */
export function SubscriptionsView({
  subscriptions,
  todayISO,
}: {
  subscriptions: Subscription[];
  todayISO: string;
}) {
  const [tab, setTab] = useState<Tab>("calendar");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent) => {
    const order = TABS.map((t) => t.id);
    const idx = order.indexOf(tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const next = order[(idx + dir + order.length) % order.length];
      setTab(next);
      tabRefs.current[next]?.focus();
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div
        className="inline-flex w-fit items-center gap-1 rounded-xl border border-border/60 bg-surface/50 p-1 text-sm"
        role="tablist"
        aria-label="Subscription views"
        onKeyDown={onKeyDown}
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          const tabId = `subscriptions-tab-${id}`;
          const panelId = `subscriptions-panel-${id}`;
          return (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={tabId}
              aria-selected={active}
              aria-controls={active ? panelId : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors",
                active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          );
        })}
      </div>

      <div
        id={`subscriptions-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`subscriptions-tab-${tab}`}
        tabIndex={0}
        className="focus-visible:outline-none"
      >
        {tab === "calendar" ? (
          <SubscriptionCalendar subscriptions={subscriptions} todayISO={todayISO} />
        ) : tab === "all" ? (
          <SubscriptionList subscriptions={subscriptions} />
        ) : (
          <SubscriptionStatistics subscriptions={subscriptions} />
        )}
      </div>
    </div>
  );
}

function StatisticsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-2xl border border-border/60 bg-surface/40"
        />
      ))}
    </div>
  );
}
