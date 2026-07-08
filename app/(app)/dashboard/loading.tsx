import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown instantly while the dashboard's server component resolves. Mirrors the
 * real layout (flip-clock hero, then a two-column usage + music grid) so the
 * transition reads as the page arriving, not a blank freeze.
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* Flip clock hero */}
      <Skeleton className="h-40 w-full rounded-2xl sm:h-48" />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: usage + connect cards */}
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
            <Skeleton className="mb-4 h-4 w-28" />
            <div className="grid grid-cols-3 gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-2">
                  <Skeleton className="size-20 rounded-full" />
                  <Skeleton className="h-3 w-14" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
            <Skeleton className="mb-3 h-4 w-40" />
            <Skeleton className="mb-4 h-3 w-full max-w-xs" />
            <Skeleton className="h-10 w-48 rounded-xl" />
          </div>
        </div>

        {/* Right: music widget */}
        <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
          <Skeleton className="mb-4 h-4 w-20" />
          <Skeleton className="mb-4 aspect-video w-full rounded-xl" />
          <Skeleton className="mb-2 h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
    </div>
  );
}
