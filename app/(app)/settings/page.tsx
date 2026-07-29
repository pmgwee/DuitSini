import { Bell } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Reveal } from "@/components/ui/reveal";
import { TelegramCard } from "@/features/settings/telegram-card";
import { ReminderScheduleCard } from "@/features/settings/reminder-schedule-card";
import { ReportsCard } from "@/features/settings/reports-card";
import { PaymentMethodsCard } from "@/features/settings/payment-methods-card";
import { RecentDeliveries } from "@/features/settings/deliveries-list";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sanitizeOffsets } from "@/lib/reminders/engine";
import type { Database } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

type DeliveryRow = Database["public"]["Tables"]["notification_deliveries"]["Row"];

/**
 * Reminders + integrations. Profile (Telegram connect state) and the delivery
 * ledger are auth-bound Supabase tables, so they're read directly here even when
 * the subscription *data* source is mock. Every read is best-effort: a transient
 * DB hiccup degrades to empty states, never a crash — the (app) shell has
 * already guaranteed a signed-in user by the time this renders.
 */
export default async function SettingsPage() {
  let connected = false;
  let enabled = false;
  let offsets = [7, 3, 1];
  let customizedCount = 0;
  let monthlyReport = true;
  let yearlyReport = true;
  let deliveries: DeliveryRow[] = [];

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await supabase
        .from("user_profiles")
        .select(
          "telegram_chat_id, telegram_enabled, reminder_offsets_days, monthly_report_enabled, yearly_report_enabled",
        )
        .eq("user_id", user.id)
        .maybeSingle();
      connected = !!profile?.telegram_chat_id;
      enabled = !!profile?.telegram_enabled;
      offsets = sanitizeOffsets(profile?.reminder_offsets_days ?? null);
      monthlyReport = profile?.monthly_report_enabled ?? true;
      yearlyReport = profile?.yearly_report_enabled ?? true;

      // Subscriptions that override the global schedule (have their own offsets).
      const { count } = await supabase
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .not("reminder_offsets_days", "is", null);
      customizedCount = count ?? 0;

      const { data: del } = await supabase
        .from("notification_deliveries")
        .select("*")
        .eq("user_id", user.id)
        .order("scheduled_for", { ascending: false })
        .limit(10);
      deliveries = (del ?? []) as DeliveryRow[];
    }
  } catch {
    // Stay at defaults (empty states).
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Reminders, reports, and messaging integrations for your account."
      />

      <Reveal>
        <TelegramCard initialConnected={connected} initialEnabled={enabled} />
      </Reveal>
      <Reveal delay={0.04}>
        <ReminderScheduleCard initialOffsets={offsets} customizedCount={customizedCount} />
      </Reveal>
      <Reveal delay={0.08}>
        <ReportsCard initialMonthly={monthlyReport} initialYearly={yearlyReport} />
      </Reveal>
      <Reveal delay={0.12}>
        <PaymentMethodsCard />
      </Reveal>
      <Reveal delay={0.16}>
        <section className="rounded-2xl border border-border/60 bg-surface/40 p-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
            <Bell className="size-4 text-primary" /> Recent reminders
          </h2>
          <RecentDeliveries deliveries={deliveries} />
        </section>
      </Reveal>
    </div>
  );
}
