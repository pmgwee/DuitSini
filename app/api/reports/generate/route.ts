import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseEnabled } from "@/lib/data";
import { rowToSubscription } from "@/lib/data/supabase/supabase-repo";
import type { Database, Json } from "@/lib/supabase/types";
import { buildMonthlyReport, buildYearlyReport } from "@/lib/reports/build";
import { renderMonthlyReportHTML, renderYearlyReportHTML } from "@/lib/reports/html";
import {
  classifyPeriodKey,
  isClosedMonth,
  isClosedYear,
} from "@/lib/reports/period";
import { toISODate } from "@/lib/domain/dates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// periodKey is either "YYYY-MM" (monthly) or "YYYY" (yearly).
const bodySchema = z.object({
  periodKey: z
    .string()
    .regex(/^\d{4}(-\d{2})?$/, "periodKey must be YYYY-MM or YYYY"),
});

/** Fetch-Metadata CSRF guard — cloned from the integrations routes. */
function crossSiteBlocked(secFetchSite: string | null): boolean {
  if (!secFetchSite) return false;
  return secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none";
}

/**
 * POST — regenerate (upsert-overwrite) the caller's OWN statement for a closed
 * period. Session-authed (RLS client) + CSRF guard; no service role anywhere.
 *
 * - Validates periodKey and that the period is fully in the past (statements
 *   only cover closed months/years — current/future → 400).
 * - Overwrites totals_json AND report_html for the user's own row (upsert on
 *   conflict; created_at is preserved since it's omitted from the payload).
 * - Does NOT send Telegram and does NOT touch the deliveries ledger (the dedupe
 *   key is unchanged, so no accidental re-send — manual regen is a silent
 *   rewrite of one's own statement, by owner design).
 *
 * No rate limit: RLS confines the blast radius to the user's own rows and
 * generation is a cheap pure computation.
 */
export async function POST(req: NextRequest) {
  if (!isSupabaseEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Reports need the Supabase backend (mock mode has none)." },
      { status: 503 },
    );
  }
  if (crossSiteBlocked((await headers()).get("sec-fetch-site"))) {
    return NextResponse.json({ ok: false, error: "Cross-site request blocked." }, { status: 403 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
  }

  const periodKey = parsed.data.periodKey;
  const kind = classifyPeriodKey(periodKey);
  if (!kind) {
    return NextResponse.json({ ok: false, error: "invalid period key" }, { status: 400 });
  }

  // Server civil today. (Per-user TZ isn't fetched here; the server date is a
  // fine closed-period guard for a manual regenerate — the edge case is a TZ
  // straddle on the first/last day of a month.)
  const todayISO = toISODate(new Date());
  if (kind === "month" && !isClosedMonth(periodKey, todayISO)) {
    return NextResponse.json(
      { ok: false, error: "Statements only cover fully-closed months." },
      { status: 400 },
    );
  }
  if (kind === "year" && !isClosedYear(periodKey, todayISO)) {
    return NextResponse.json(
      { ok: false, error: "Statements only cover fully-closed years." },
      { status: 400 },
    );
  }

  // Read the user's own subscriptions (RLS) — same mapping the repo uses.
  const { data: rows, error: sErr } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", user.id);
  if (sErr) {
    return NextResponse.json({ ok: false, error: sErr.message }, { status: 500 });
  }
  const subs = (rows ?? []).map((r) =>
    rowToSubscription(r as Database["public"]["Tables"]["subscriptions"]["Row"]),
  );

  if (kind === "month") {
    const totals = buildMonthlyReport(subs, periodKey, todayISO);
    const html = renderMonthlyReportHTML(totals);
    const { error } = await supabase.from("monthly_reports").upsert(
      {
        user_id: user.id,
        month_key: periodKey,
        totals_json: totals as unknown as Json,
        report_html: html,
      },
      { onConflict: "user_id,month_key" },
    );
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, kind: "month", periodKey });
  }

  const totals = buildYearlyReport(subs, periodKey, todayISO);
  const html = renderYearlyReportHTML(totals);
  const { error } = await supabase.from("yearly_reports").upsert(
    {
      user_id: user.id,
      year_key: periodKey,
      totals_json: totals as unknown as Json,
      report_html: html,
    },
    { onConflict: "user_id,year_key" },
  );
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, kind: "year", periodKey });
}
