import { CalendarDays, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { CATEGORIES, CATEGORY_META } from "@/lib/constants";

export default function SubscriptionsPage() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Subscriptions"
        description="Track every renewal, trial, and recurring bill in one calm, visual place."
        actions={
          <Button className="gap-1.5">
            <Plus className="size-4" />
            Add subscription
          </Button>
        }
      />

      {/* Tabs — interactive calendar / statistics arrive in Phase 4 */}
      <div className="inline-flex w-fit items-center gap-1 rounded-xl border border-border/60 bg-surface/50 p-1 text-sm">
        <span className="rounded-lg bg-accent px-3 py-1.5 font-medium">Calendar</span>
        <span className="rounded-lg px-3 py-1.5 text-muted-foreground">Statistics</span>
      </div>

      <EmptyState
        icon={CalendarDays}
        title="Your calendar is ready"
        description="Add your first subscription to see upcoming charges, trial conversions, and monthly totals laid out on a beautiful calendar."
        action={
          <Button className="gap-1.5">
            <Plus className="size-4" />
            Add your first subscription
          </Button>
        }
      />

      {/* Sticky category overview dock */}
      <div className="sticky bottom-4 z-20 lg:bottom-6">
        <div className="glass card-elevated rounded-2xl border border-border/60 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Overview by category
            </span>
            <span className="text-xs text-muted-foreground">0 active</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((category) => (
              <span
                key={category}
                className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-surface/60 px-3 py-1.5 text-xs"
              >
                <span
                  className="size-2 rounded-full"
                  style={{ background: CATEGORY_META[category].colorVar }}
                />
                {CATEGORY_META[category].label}
                <span className="text-muted-foreground">0</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
