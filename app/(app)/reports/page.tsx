import Link from "next/link";
import { FileText, CalendarRange, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { isSupabaseEnabled } from "@/lib/data";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";
import { toISODate, formatLongDate } from "@/lib/domain/dates";
import { formatCurrency } from "@/lib/domain/money";
import { HOME_CURRENCY } from "@/lib/domain/fx";
import { prevMonthKeyFromToday } from "@/lib/reports/period";
import type { MonthlyReportTotalsV1, YearlyReportTotalsV1 } from "@/lib/reports/types";
import { GenerateButton } from "@/features/reports/generate-button";

export const dynamic = "force-dynamic";

interface ReportListItem {
  kind: "month" | "year";
  key: string;
  createdAt: string;
  generatedOnISO: string | null;
  totalMYR: number | null;
  deltaPct: number | null;
}

/** Read the headline figures from a stored snapshot (v1 only). */
function readTotals(totalsJson: Json | null): {
  totalMYR: number | null;
  deltaPct: number | null;
  generatedOnISO: string | null;
} {
  const t = totalsJson as {
    v?: number;
    totalMYR?: number;
    deltaPct?: number | null;
    generatedOnISO?: string;
  } | null;
  if (!t || t.v !== 1 || typeof t.totalMYR !== "number") {
    return { totalMYR: null, deltaPct: null, generatedOnISO: null };
  }
  return {
    totalMYR: t.totalMYR,
    deltaPct: t.deltaPct ?? null,
    generatedOnISO: typeof t.generatedOnISO === "string" ? t.generatedOnISO : null,
  };
}

/** "June 2026" for a month key, "2025" for a year key. */
function periodLabel(kind: "month" | "year", key: string): string {
  if (kind === "year") return key;
  const [yyyy, mm] = key.split("-").map(Number);
  return new Date(yyyy, mm - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function deltaText(deltaPct: number | null): string {
  if (deltaPct == null) return "new period";
  const arrow = deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "→";
  return `${arrow} ${Math.abs(deltaPct).toFixed(deltaPct % 1 === 0 ? 0 : 1)}%`;
}

/**
 * Reports index — the list of stored monthly & yearly statements (newest first),
 * with a "Generate last month" button for first-timers who don't want to wait for
 * the 1st-of-month cron. Renders the snapshot figures (never recomputes).
 *
 * Mock mode: there is no mock report store, so we show the empty-state note
 * instead of a 500 (CLAUDE.md data-source rule).
 */
export default async function ReportsPage() {
  const items: ReportListItem[] = [];

  if (isSupabaseEnabled()) {
    try {
      const supabase = await createSupabaseServerClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user) {
        const [monthly, yearly] = await Promise.all([
          supabase
            .from("monthly_reports")
            .select("month_key, created_at, totals_json")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false }),
          supabase
            .from("yearly_reports")
            .select("year_key, created_at, totals_json")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false }),
        ]);

        for (const m of (monthly.data ?? []) as {
          month_key: string;
          created_at: string;
          totals_json: Json | null;
        }[]) {
          const t = readTotals(m.totals_json);
          items.push({
            kind: "month",
            key: m.month_key,
            createdAt: m.created_at,
            generatedOnISO: t.generatedOnISO,
            totalMYR: t.totalMYR,
            deltaPct: t.deltaPct,
          });
        }
        for (const y of (yearly.data ?? []) as {
          year_key: string;
          created_at: string;
          totals_json: Json | null;
        }[]) {
          const t = readTotals(y.totals_json);
          items.push({
            kind: "year",
            key: y.year_key,
            createdAt: y.created_at,
            generatedOnISO: t.generatedOnISO,
            totalMYR: t.totalMYR,
            deltaPct: t.deltaPct,
          });
        }
        items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
    } catch {
      // Stay at empty state — a transient DB hiccup degrades gracefully.
    }
  }

  const lastMonthKey = prevMonthKeyFromToday(toISODate(new Date()));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Monthly and yearly statements, generated on the 1st and saved as snapshots."
        actions={isSupabaseEnabled() ? <GenerateButton periodKey={lastMonthKey} /> : undefined}
      />

      {!isSupabaseEnabled() ? (
        <EmptyState
          icon={FileText}
          title="Reports need the Supabase backend"
          description="In mock mode there's no report store. Switch NEXT_PUBLIC_DATA_SOURCE to supabase to generate statements."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No reports yet"
          description="Your first monthly statement generates on the 1st — or generate last month now to see one immediately."
          action={<GenerateButton periodKey={lastMonthKey} />}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const Icon = item.kind === "month" ? FileText : CalendarRange;
            // Prefer the snapshot's civil generation date; fall back to created_at's
            // date for rows lacking it. Avoids the UTC-instant/server-TZ off-by-one.
            const generatedLabel = formatLongDate(
              (item.generatedOnISO ?? item.createdAt.slice(0, 10)).slice(0, 10),
            );
            return (
              <li key={`${item.kind}:${item.key}`}>
                <Link
                  href={`/reports/${item.key}`}
                  className="group flex items-center gap-4 rounded-2xl border border-border/60 bg-surface/40 p-5 transition-colors hover:bg-surface/70"
                >
                  <div className="grid size-11 place-items-center rounded-xl bg-primary/12 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{periodLabel(item.kind, item.key)}</span>
                      <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {item.kind === "month" ? "Monthly" : "Yearly"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">Generated {generatedLabel}</div>
                  </div>
                  <div className="text-right">
                    {item.totalMYR == null ? (
                      <span className="text-xs text-muted-foreground">Needs regenerating</span>
                    ) : (
                      <>
                        <div className="text-sm font-semibold tabular-nums">
                          {formatCurrency(item.totalMYR, HOME_CURRENCY)}
                        </div>
                        <div
                          className={`text-[11px] ${
                            item.deltaPct == null
                              ? "text-muted-foreground"
                              : item.deltaPct > 0
                                ? "text-success"
                                : item.deltaPct < 0
                                  ? "text-danger"
                                  : "text-muted-foreground"
                          }`}
                        >
                          {deltaText(item.deltaPct)}
                        </div>
                      </>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {items.length > 0 ? (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
          <TrendingUp className="size-3.5" />
          Statements are snapshots — they don&apos;t change when you edit a subscription later.
        </p>
      ) : null}
    </div>
  );
}
