import { type NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseEnabled } from "@/lib/data";
import type { Json } from "@/lib/supabase/types";
import { classifyPeriodKey } from "@/lib/reports/period";
import { renderUrlToPdf } from "@/lib/reports/pdf";
import {
  buildMonthlyReportMessage,
  buildYearlyReportMessage,
} from "@/lib/notify/messages";
import { sendTelegramDocument } from "@/lib/notify/telegram";
import type {
  MonthlyReportTotalsV1,
  YearlyReportTotalsV1,
} from "@/lib/reports/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// First call pays the Chromium pack download + cold start; allow headroom.
export const maxDuration = 120;

/** Fetch-Metadata CSRF guard — mirrors the other session-authed report routes. */
function crossSiteBlocked(secFetchSite: string | null): boolean {
  if (!secFetchSite) return false;
  return secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none";
}

/**
 * Resolve the app origin to navigate to for the live render. Prefer
 * NEXT_PUBLIC_APP_URL; else derive from the request's forwarded host/proto
 * (Vercel sets both); else assume local dev. Trailing slash trimmed.
 */
function resolveOrigin(req: NextRequest): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const proto = req.headers.get("x-forwarded-proto") ?? "http";
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) return `${proto}://${host}`;
  return "http://localhost:3000";
}

/**
 * POST — render the caller's LIVE report page to PDF via Chromium and send it
 * to their linked Telegram chat as a document. Session-authed (RLS) + CSRF.
 * No service role. The report content (their own data) goes: app → Chromium
 * (in-process, navigating the app's own report URL with the caller's session
 * cookies) → Telegram — never a third-party renderer.
 *
 * Rendering the live page (not the stored `report_html` template) makes the
 * PDF match the on-screen report / the in-app Print button — one source of
 * truth for styling. Manual/user-initiated, so deliveries are audited but NOT
 * deduped (the user may re-send).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ periodKey: string }> }) {
  if (!isSupabaseEnabled()) {
    return NextResponse.json(
      { ok: false, error: "Reports need the Supabase backend." },
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

  const { periodKey } = await ctx.params;
  const kind = classifyPeriodKey(periodKey);
  if (!kind) {
    return NextResponse.json({ ok: false, error: "invalid period key" }, { status: 400 });
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("telegram_chat_id")
    .eq("user_id", user.id)
    .maybeSingle();
  const chatId = (profile as { telegram_chat_id: string | null } | null)?.telegram_chat_id;
  if (!chatId) {
    return NextResponse.json(
      { ok: false, error: "Connect Telegram first — Settings → Telegram." },
      { status: 400 },
    );
  }

  const table = kind === "month" ? "monthly_reports" : "yearly_reports";
  const keyCol = kind === "month" ? "month_key" : "year_key";
  const { data: row } = await supabase
    .from(table)
    .select("totals_json")
    .eq("user_id", user.id)
    .eq(keyCol as never, periodKey)
    .maybeSingle();
  const r = row as { totals_json: Json | null } | null;
  if (!r) {
    return NextResponse.json({ ok: false, error: "Report not found." }, { status: 404 });
  }

  const totals = r.totals_json as { v?: number } | null;
  if (totals?.v !== 1) {
    return NextResponse.json(
      { ok: false, error: "Regenerate this report before sending." },
      { status: 400 },
    );
  }

  const appUrl = resolveOrigin(req);
  const caption =
    kind === "month"
      ? buildMonthlyReportMessage(totals as MonthlyReportTotalsV1, appUrl).html
      : buildYearlyReportMessage(totals as YearlyReportTotalsV1, appUrl).html;

  // PDF source: the LIVE report page (same render as the in-app Print button),
  // reached through the in-process Chromium with the caller's session cookies
  // so RLS-authed SSR shows their own report. The website page is the single
  // source of truth — sections, colors, and styling always match the screen.
  const reportUrl = `${appUrl}/reports/${periodKey}`;
  const sessionCookies = (await cookies()).getAll();

  let pdf: Uint8Array;
  try {
    pdf = await renderUrlToPdf(reportUrl, sessionCookies);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "PDF render failed";
    console.error("[reports/send-telegram] render failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const result = await sendTelegramDocument(chatId, `report-${periodKey}.pdf`, pdf, caption);

  // Audit (RLS-scoped, own row). Manual → not deduped (null key).
  await supabase.from("notification_deliveries").insert({
    user_id: user.id,
    subscription_id: null,
    channel: "telegram",
    scheduled_for: new Date().toISOString(),
    status: result.outcome === "sent" ? "sent" : result.outcome === "skipped" ? "skipped" : "failed",
    sent_at: result.outcome === "sent" ? new Date().toISOString() : null,
    error_message: result.outcome === "failed" ? result.errorMessage : null,
    payload_json: {
      report: true,
      reportPdf: true,
      key: periodKey,
      kind,
      recipient: chatId,
    } as unknown as Json,
    dedupe_key: null,
  });

  if (result.outcome !== "sent") {
    return NextResponse.json(
      { ok: false, error: result.errorMessage ?? result.skipReason ?? "send failed" },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
