import { PageHeader } from "@/components/ui/page-header";
import { FlipClock } from "@/features/dashboard/flip-clock";
import { ClaudeUsageTracker } from "@/features/dashboard/claude-usage-tracker";
import { MusicWidget } from "@/features/dashboard/music/music-widget";

export default function DashboardPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="A calm personal command center — usage, music, and time at a glance."
      />

      {/* Flip clock — hero */}
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-surface/40">
        <FlipClock />
      </div>

      {/* Claude usage + music */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ClaudeUsageTracker />
        <MusicWidget />
      </div>
    </div>
  );
}
