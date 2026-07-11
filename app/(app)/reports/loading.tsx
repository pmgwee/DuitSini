import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while the reports index resolves (listing the user's stored statements).
 * Mirrors the header + generate button + the statement list.
 */
export default function ReportsLoading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Header + generate button */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 rounded-xl" />
      </div>

      {/* Statement list */}
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 rounded-2xl border border-border/60 bg-surface/40 p-5">
            <Skeleton className="size-11 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-40" />
            </div>
            <div className="space-y-2 text-right">
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="ml-auto h-3 w-12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
