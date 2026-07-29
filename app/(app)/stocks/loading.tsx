import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown while /stocks resolves. The route is force-dynamic and blocks on
 * external fetches (lib/serenity), so without this the page flashes blank on
 * slow networks. Mirrors the header + section-card stack so the load feels
 * structured. Every other app route already has a loading.tsx.
 */
export default function StocksLoading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Header + source link */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-8 w-28 rounded-full" />
      </div>

      {/* Section card stack */}
      <div className="flex flex-col gap-4">
        <Skeleton className="h-40 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    </div>
  );
}
