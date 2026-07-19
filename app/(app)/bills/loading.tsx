import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown instantly while the subscriptions server component resolves (repo list
 * + today computation). Mirrors the page header, the tab switcher, and a
 * calendar grid so navigating from the dashboard feels immediate.
 */
export default function SubscriptionsLoading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Page header */}
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-24 rounded-xl" />
      </div>

      {/* Tab switcher */}
      <Skeleton className="h-10 w-64 rounded-xl" />

      {/* Calendar month header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-9 w-32 rounded-xl" />
      </div>

      {/* Weekday labels */}
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="mx-auto h-3 w-8" />
        ))}
      </div>

      {/* 42-cell grid */}
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: 42 }).map((_, i) => (
          <Skeleton key={i} className="min-h-16 rounded-xl sm:min-h-24" />
        ))}
      </div>
    </div>
  );
}
