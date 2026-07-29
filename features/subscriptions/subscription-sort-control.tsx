"use client";

import { ArrowDownWideNarrow } from "lucide-react";
import { Select, type SelectOption } from "@/components/ui/select";
import { SUBSCRIPTION_SORT_OPTIONS, type SubscriptionSortKey } from "./subscription-sort";

const ALL_OPTIONS: SelectOption[] = SUBSCRIPTION_SORT_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
}));

/**
 * Compact "Sort by" control for the subscription lists. Built on the shared
 * `Select` (so it stays themed + accessible) but shrunk to a list-header size
 * via `triggerClassName`. Pass {@link keys} to restrict the available dimensions
 * (e.g. omit "status" where it isn't meaningful).
 */
export function SubscriptionSortControl({
  value,
  onChange,
  keys,
  ariaLabel = "Sort subscriptions",
}: {
  value: SubscriptionSortKey;
  onChange: (key: SubscriptionSortKey) => void;
  /** Restrict the menu to a subset of sort keys; defaults to all. */
  keys?: readonly SubscriptionSortKey[];
  ariaLabel?: string;
}) {
  const options = keys
    ? ALL_OPTIONS.filter((o) => (keys as readonly string[]).includes(o.value))
    : ALL_OPTIONS;
  return (
    <Select
      value={value}
      onChange={(v) => onChange(v as SubscriptionSortKey)}
      options={options}
      ariaLabel={ariaLabel}
      searchable={false}
      className="min-w-48"
      triggerClassName="h-8 w-full rounded-lg px-2.5 text-xs"
      leadingIcon={<ArrowDownWideNarrow className="size-3.5 shrink-0 text-muted-foreground" />}
    />
  );
}
