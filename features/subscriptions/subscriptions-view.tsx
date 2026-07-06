"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { BarChart3, CalendarDays, type LucideIcon } from "lucide-react";
import type { Subscription } from "@/types/subscription";
import { cn } from "@/lib/utils";
import { SubscriptionCalendar } from "./subscription-calendar";

// Lazy-load so Recharts is only fetched when the Statistics tab is opened.
const SubscriptionStatistics = dynamic(
  () => import("./subscription-statistics").then((m) => m.SubscriptionStatistics),
  {
    ssr: false,
    loading: () => <StatisticsSkeleton />,
  },
);

type Tab = "calendar" | "statistics";

/**
 * Tabbed Page-1 surface: Calendar (live) and Statistics (live, lazy-loaded).
 */
export function SubscriptionsView({
  subscriptions,
  todayISO,
}: {
  subscriptions: Subscription[];
  todayISO: string;
}) {
  const [tab, setTab] = useState<Tab>("calendar");

  return (
    <div className="flex flex-col gap-6">
      <div
        className="inline-flex w-fit items-center gap-1 rounded-xl border border-border/60 bg-surface/50 p-1 text-sm"
        role="tablist"
      >
        <TabButton
          active={tab === "calendar"}
          onClick={() => setTab("calendar")}
          icon={CalendarDays}
          label="Calendar"
        />
        <TabButton
          active={tab === "statistics"}
          onClick={() => setTab("statistics")}
          icon={BarChart3}
          label="Statistics"
        />
      </div>

      {tab === "calendar" ? (
        <SubscriptionCalendar subscriptions={subscriptions} todayISO={todayISO} />
      ) : (
        <SubscriptionStatistics subscriptions={subscriptions} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      {label}
    </button>
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
