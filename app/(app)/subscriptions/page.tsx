import { Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { getEffectiveUserId, getSubscriptionRepository } from "@/lib/data";
import { toISODate } from "@/lib/domain/dates";
import { SubscriptionsView } from "@/features/subscriptions/subscriptions-view";
import { CategoryDock } from "@/features/subscriptions/category-dock";

export default async function SubscriptionsPage() {
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  const subscriptions = await repo.list(userId);
  // Computed on the server so the client calendar's initial render is
  // deterministic (no new Date() in client state → no hydration mismatch).
  const todayISO = toISODate(new Date());

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

      <SubscriptionsView subscriptions={subscriptions} todayISO={todayISO} />

      <CategoryDock subscriptions={subscriptions} />
    </div>
  );
}
