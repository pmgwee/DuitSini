import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the settings layout: header + Telegram + reminders + reports + recent. */
export default function SettingsLoading() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>

      {/* Telegram */}
      <div className="rounded-2xl border border-border/60 bg-surface/40 p-6">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <Skeleton className="h-10 w-36 rounded-xl" />
        </div>
      </div>

      {/* Reminders */}
      <div className="rounded-2xl border border-border/60 bg-surface/40 p-6">
        <Skeleton className="mb-4 h-5 w-48" />
        <Skeleton className="mb-4 h-4 w-72 max-w-full" />
        <div className="flex flex-wrap gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-24" />
          ))}
        </div>
        <Skeleton className="mt-4 h-4 w-80 max-w-full" />
      </div>

      {/* Reports */}
      <div className="rounded-2xl border border-border/60 bg-surface/40 p-6">
        <Skeleton className="mb-4 h-5 w-28" />
        <Skeleton className="mb-4 h-4 w-80 max-w-full" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-52" />
              </div>
              <Skeleton className="h-6 w-11 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* Recent reminders */}
      <div className="rounded-2xl border border-border/60 bg-surface/40 p-6">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-4 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
