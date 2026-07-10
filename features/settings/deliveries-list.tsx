import { Ban, CheckCircle2, Clock, XCircle, type LucideIcon } from "lucide-react";
import type { Database } from "@/lib/supabase/types";
import { formatLongDate } from "@/lib/domain/dates";
import { cn } from "@/lib/utils";

type DeliveryRow = Database["public"]["Tables"]["notification_deliveries"]["Row"];
type Status = DeliveryRow["status"];

const STATUS_META: Record<Status, { icon: LucideIcon; label: string; className: string }> = {
  sent: { icon: CheckCircle2, label: "Sent", className: "text-success" },
  pending: { icon: Clock, label: "Pending", className: "text-muted-foreground" },
  failed: { icon: XCircle, label: "Failed", className: "text-danger" },
  skipped: { icon: Ban, label: "Skipped", className: "text-muted-foreground" },
};

/** A digest's included reminder (stored in payload_json.items). */
interface DigestItem {
  name?: string;
  kind?: string;
  chargeISO?: string;
}

interface PayloadShape {
  digest?: boolean;
  date?: string;
  name?: string;
  chargeISO?: string;
  items?: DigestItem[];
}

/**
 * Last 10 delivery ledger rows for the signed-in user, each with a status chip.
 * Doubles as the audit log: it shows what was sent (now as a daily DIGEST
 * bundling multiple reminders), what failed (and why), and what was skipped.
 */
export function RecentDeliveries({ deliveries }: { deliveries: DeliveryRow[] }) {
  if (deliveries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No reminders sent yet. They appear here once the daily sweep fires and a
        renewal or trial conversion is due.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border/50">
      {deliveries.map((d) => {
        const meta = STATUS_META[d.status] ?? STATUS_META.pending;
        const payload = (d.payload_json ?? {}) as PayloadShape;
        const Icon = meta.icon;

        // Digest row (the current format): one message bundling N reminders.
        const items = payload.digest ? payload.items ?? [] : [];
        const dateLabel = payload.digest
          ? payload.date
          : payload.chargeISO;

        return (
          <li key={d.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
            <Icon className={cn("mt-0.5 size-4 shrink-0", meta.className)} />
            <div className="min-w-0 flex-1">
              {payload.digest ? (
                <>
                  <div className="text-sm font-medium">
                    📋 Daily digest{items.length ? ` · ${items.length}` : ""}
                  </div>
                  {items.length > 0 ? (
                    <ul className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {items.map((it, i) => (
                        <li key={i} className="truncate">
                          {it.kind === "trial" ? "⚠️ " : "⏰ "}
                          {it.name ?? "Subscription"}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-0.5 text-[11px] text-muted-foreground/80">
                    {d.channel} · {meta.label}
                    {d.error_message ? ` · ${d.error_message}` : ""}
                  </div>
                </>
              ) : (
                <>
                  <div className="truncate text-sm font-medium">
                    {payload.name ?? "Subscription"}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {d.channel} · {meta.label}
                    {d.error_message ? ` · ${d.error_message}` : ""}
                  </div>
                </>
              )}
            </div>
            {dateLabel ? (
              <div className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">
                {formatLongDate(dateLabel)}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
