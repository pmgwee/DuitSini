import { PageHeader } from "@/components/ui/page-header";
import { Reveal } from "@/components/ui/reveal";
import { getEffectiveUserId, getSubscriptionRepository } from "@/lib/data";
import { toISODate } from "@/lib/domain/dates";
import { AddSubscriptionButton } from "@/features/subscriptions/subscription-dialogs";
import { SubscriptionsView } from "@/features/subscriptions/subscriptions-view";

/**
 * /bills — DuitSini's recurring-outgoings pillar. Named "Bills" rather than
 * "Subscriptions" because the surface covers three kinds of commitment: streaming
 * and SaaS subscriptions, utilities (TNB / water / Indah Water), and bank
 * repayments — only the first of which is literally a subscription.
 *
 * The route and label name the *surface*; the module, repository, domain types and
 * DB table keep the `subscription` vocabulary they were built with (same split as
 * /stocks ↔ lib/serenity). Renaming those would mean a migration and a type regen
 * for zero user-visible gain.
 */
export default async function BillsPage() {
  const userId = await getEffectiveUserId();
  const repo = await getSubscriptionRepository();
  const subscriptions = await repo.list(userId);
  // Computed on the server so the client calendar's initial render is
  // deterministic (no new Date() in client state → no hydration mismatch).
  const todayISO = toISODate(new Date());

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Bills"
        description="Every subscription, utility, and repayment — each renewal and trial in one calm, visual place."
        actions={<AddSubscriptionButton />}
      />

      <Reveal>
        <SubscriptionsView subscriptions={subscriptions} todayISO={todayISO} />
      </Reveal>
    </div>
  );
}
