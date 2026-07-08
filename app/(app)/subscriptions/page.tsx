import { PageHeader } from "@/components/ui/page-header";
import { getEffectiveUserId, getSubscriptionRepository } from "@/lib/data";
import { toISODate } from "@/lib/domain/dates";
import { AddSubscriptionButton } from "@/features/subscriptions/subscription-dialogs";
import { SubscriptionsView } from "@/features/subscriptions/subscriptions-view";

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
        actions={<AddSubscriptionButton />}
      />

      <SubscriptionsView subscriptions={subscriptions} todayISO={todayISO} />
    </div>
  );
}
