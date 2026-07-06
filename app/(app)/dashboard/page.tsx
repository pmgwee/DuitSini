import { Music4, Timer } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { LiveClock } from "@/features/dashboard/live-clock";

export default function DashboardPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="A calm personal command center — usage, music, and time at a glance."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Timer className="size-4" /> Claude usage
          </div>
          <div className="mt-6 grid place-items-center py-10 text-center text-sm text-muted-foreground">
            Session tracking arrives in Phase 5 — rolling 5-hour and 7-day windows
            with live reset timers.
          </div>
        </Card>

        <Card className="overflow-hidden p-0 lg:col-span-2">
          <LiveClock />
        </Card>

        <Card className="p-5 lg:col-span-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Music4 className="size-4" /> Now playing
          </div>
          <div className="mt-6 grid place-items-center py-10 text-center text-sm text-muted-foreground">
            Connect a music source to see album art, track details, and playback
            controls.
          </div>
        </Card>
      </div>
    </div>
  );
}
