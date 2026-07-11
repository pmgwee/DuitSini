import { type NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { rowToSubscription } from "@/lib/data/supabase/supabase-repo";
import type { Database, Json } from "@/lib/supabase/types";
import type { Subscription } from "@/types/subscription";
import { buildMonthlyReport, buildYearlyReport } from "@/lib/reports/build";
import { renderMonthlyReportHTML, renderYearlyReportHTML } from "@/lib/reports/html";
import { buildMonthlyReportMessage, buildYearlyReportMessage } from "@/lib/notify/messages";
import { getProvider, type NotifyPayload } from "@/lib/notify";
import { sendOpsAlert } from "@/lib/notify/ops-alert";
import { parseISODate } from "@/lib/domain/dates";
import {
  todayISOFor,
  prevMonthKeyFromToday,
  prevYearKeyFromToday,
  withinGenerationWindow,
} from "@/lib/reports/period";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation is cheap (pure builders) but the sweep pages every report-enabled
// user once a day; 300s is Vercel's current function ceiling and leaves real
// headroom. A separate route (not folded into reminders) keeps failure domains
// and time budgets independent — statement generation must never delay a reminder.
export const maxDuration = 300;

const PAGE_SIZE = 500; // profiles per .range() page
const CHUNK = 100; // max ids per .in() query (PostgREST URL-length safety)
const SOFT_BUDGET_MS = 240_000; // stop paging ~1 min before the hard ceiling
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // days 1–3 catch-up window
// A failed report delivery must be at least this old before retry re-attempts it:
// real backoff + excludes rows this invocation just inserted/failed seconds ago.
const RETRY_MIN_AGE_MS = 10 * 60 * 1000;
const DRY_SAMPLE_CAP = 50;

type DeliveryStatus = Database["public"]["Enums"]["delivery_status"];

interface Summary {
  users: number;
  monthlyGenerated: number;
  yearlyGenerated: number;
  sent: number;
  skipped: number;
  failed: number;
  retriesAttempted: number;
  truncated: number;
}

/** Authorize via the shared CRON_SECRET Vercel Cron injects as a bearer token. */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface ProfileRow {
  user_id: string;
  timezone: string | null;
  telegram_chat_id: string | null;
  telegram_enabled: boolean;
  monthly_report_enabled: boolean;
  yearly_report_enabled: boolean;
}

/** Set a delivery ledger row's status (and sent_at when it succeeded). */
async function setStatus(
  admin: SupabaseClient<Database>,
  id: string,
  status: DeliveryStatus,
  errorMessage?: string,
  markSent = false,
): Promise<void> {
  const patch: Database["public"]["Tables"]["notification_deliveries"]["Update"] = {
    status,
    error_message: errorMessage ?? null,
  };
  if (markSent) patch.sent_at = new Date().toISOString();
  await admin.from("notification_deliveries").update(patch).eq("id", id);
}

/**
 * user_ids who already have a stored report for `keyVal`. Chunked so each .in()
 * stays well under PostgREST's URL-length ceiling.
 */
async function existingKeys(
  admin: SupabaseClient<Database>,
  table: "monthly_reports" | "yearly_reports",
  keyCol: "month_key" | "year_key",
  keyVal: string,
  userIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of chunkArray(userIds, CHUNK)) {
    const { data } = await admin
      .from(table)
      .select("user_id")
      .in("user_id", chunk)
      // The table is a union of monthly/yearly; their key columns don't overlap,
      // so the typed-builder narrows keyCol out. The (table, keyCol) pairs passed
      // here always match, so cast through to satisfy the union.
      .eq(keyCol as never, keyVal);
    for (const r of (data ?? []) as { user_id: string }[]) out.add(r.user_id);
  }
  return out;
}

/**
 * Every user_id with Telegram linked AND enabled — the COMPLETE retry-
 * eligibility set, independent of the paged generation sweep (which may have
 * truncated, or filtered out users who disabled reports after a delivery
 * failed). Paged to stay under PostgREST URL limits even at scale.
 */
async function fetchTelegramEligible(admin: SupabaseClient<Database>): Promise<Set<string>> {
  const out = new Set<string>();
  let page = 0;
  while (true) {
    const from = page * PAGE_SIZE;
    const { data, error } = await admin
      .from("user_profiles")
      .select("user_id")
      .eq("telegram_enabled", true)
      .not("telegram_chat_id", "is", null)
      .order("user_id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) break;
    const rows = (data ?? []) as { user_id: string }[];
    if (rows.length === 0) break;
    for (const r of rows) out.add(r.user_id);
    if (rows.length < PAGE_SIZE) break;
    page++;
  }
  return out;
}

/** Fetch every subscription for the given users, grouped by user_id. */
async function fetchSubsByUser(
  admin: SupabaseClient<Database>,
  userIds: string[],
): Promise<Map<string, Subscription[]>> {
  const out = new Map<string, Subscription[]>();
  for (const chunk of chunkArray(userIds, CHUNK)) {
    const { data, error } = await admin.from("subscriptions").select("*").in("user_id", chunk);
    if (error) {
      console.error("[cron/reports] subs fetch failed:", error.message);
      continue;
    }
    for (const row of (data ?? []) as Database["public"]["Tables"]["subscriptions"]["Row"][]) {
      const sub = rowToSubscription(row);
      const arr = out.get(sub.userId);
      if (arr) arr.push(sub);
      else out.set(sub.userId, [sub]);
    }
  }
  return out;
}

interface ReportDeliveryPlan {
  table: "monthly_reports" | "yearly_reports";
  rowId: string;
  userId: string;
  key: string;
  kind: "month" | "year";
  message: NotifyPayload;
}

interface DryReportItem {
  userId: string;
  key: string;
  kind: "month" | "year";
  recipient: string | null;
}

/**
 * Deliver one freshly-generated report to a Telegram-linked user. Idempotent via
 * the dedupe key `${userId}:telegram:report:${key}`: a repeat run (day 2/3, or a
 * retry) finds the row already present → 23505 → skip. Records the outcome on the
 * report row's `delivered_channels_json`. Never throws.
 */
async function deliverOne(
  admin: SupabaseClient<Database>,
  plan: ReportDeliveryPlan,
  recipient: string,
  dry: boolean,
  summary: Summary,
  dryReports: DryReportItem[],
): Promise<void> {
  const channel = "telegram" as const;
  const dedupeKey = `${plan.userId}:telegram:report:${plan.key}`;

  if (dry) {
    dryReports.push({ userId: plan.userId, key: plan.key, kind: plan.kind, recipient });
    return;
  }

  const payload = {
    report: true,
    key: plan.key,
    kind: plan.kind,
    text: plan.message.text,
    html: plan.message.html,
    recipient,
  } as unknown as Json;

  const insert = {
    user_id: plan.userId,
    subscription_id: null,
    channel,
    scheduled_for: new Date().toISOString(),
    status: "pending" as DeliveryStatus,
    payload_json: payload,
    dedupe_key: dedupeKey,
  };
  const { data: inserted, error } = await admin
    .from("notification_deliveries")
    .insert(insert)
    .select("id")
    .single();
  // 23505 unique_violation (already delivered / in-flight) → clean skip.
  if (error || !inserted) {
    summary.skipped++;
    return;
  }
  const deliveryId = (inserted as { id: string }).id;

  const provider = getProvider(channel);
  if (!provider || !provider.isConfigured()) {
    await setStatus(admin, deliveryId, "skipped", "telegram not configured");
    summary.skipped++;
    await markDeliveredChannels(admin, plan, "skipped");
    return;
  }

  const result = await provider.send(recipient, plan.message);
  const status: "sent" | "skipped" | "failed" =
    result.outcome === "sent" ? "sent" : result.outcome === "skipped" ? "skipped" : "failed";
  if (status === "sent") {
    await setStatus(admin, deliveryId, "sent", undefined, true);
    summary.sent++;
  } else if (status === "skipped") {
    await setStatus(admin, deliveryId, "skipped", result.skipReason);
    summary.skipped++;
  } else {
    await setStatus(admin, deliveryId, "failed", result.errorMessage);
    summary.failed++;
  }
  await markDeliveredChannels(admin, plan, status);
}

/** Stamp the delivery outcome onto the report row's delivered_channels_json. */
async function markDeliveredChannels(
  admin: SupabaseClient<Database>,
  plan: ReportDeliveryPlan,
  status: "sent" | "skipped" | "failed",
): Promise<void> {
  const channels = [{ channel: "telegram" as const, at: new Date().toISOString(), status }];
  await admin
    .from(plan.table)
    .update({ delivered_channels_json: channels as unknown as Json })
    .eq("id", plan.rowId);
}

/**
 * Re-attempt report deliveries that failed within the 3-day window. Self-
 * contained: recipient + message are read back from payload_json. Guards: the
 * 3-day window, a recency floor (excludes rows this run just failed), the
 * telegram-eligible set (honor a disable/unlink since the failure), and an
 * atomic claim (only resend if still `failed`). Identifies report rows by the
 * `:telegram:report:` marker in the dedupe key (reminder keys never contain it).
 */
async function retryFailed(
  admin: SupabaseClient<Database>,
  telegramEligible: Set<string>,
  summary: Summary,
): Promise<void> {
  const now = Date.now();
  const since = new Date(now - RETRY_WINDOW_MS).toISOString();
  const minAge = new Date(now - RETRY_MIN_AGE_MS).toISOString();

  // Recover rows stuck at 'pending' by a run that crashed mid-send.
  await admin
    .from("notification_deliveries")
    .update({ status: "failed" as DeliveryStatus, error_message: "recovered from stuck pending" })
    .eq("status", "pending")
    .like("dedupe_key", "%:telegram:report:%")
    .lt("scheduled_for", minAge);

  const { data: failed } = await admin
    .from("notification_deliveries")
    .select("id, user_id, payload_json")
    .eq("status", "failed")
    .like("dedupe_key", "%:telegram:report:%")
    .gte("scheduled_for", since)
    .lt("scheduled_for", minAge);

  for (const row of (failed ?? []) as {
    id: string;
    user_id: string;
    payload_json: Json | null;
  }[]) {
    if (!telegramEligible.has(row.user_id)) {
      await setStatus(admin, row.id, "skipped", "telegram no longer enabled");
      summary.skipped++;
      continue;
    }

    const { data: claimed } = await admin
      .from("notification_deliveries")
      // Bump scheduled_for on claim so a CONCURRENT run's stuck-pending sweep
      // (which keys on scheduled_for < minAge) can't misread this just-claimed
      // row as stuck, flip it back to failed, and re-send it (double-send).
      .update({
        status: "pending" as DeliveryStatus,
        error_message: null,
        scheduled_for: new Date().toISOString(),
      })
      .eq("id", row.id)
      .in("status", ["failed"])
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    summary.retriesAttempted++;
    const payload = (row.payload_json ?? {}) as {
      recipient?: string;
      text?: string;
      html?: string;
      kind?: "month" | "year";
      key?: string;
    };
    const provider = getProvider("telegram");
    if (!provider || !provider.isConfigured() || !payload.recipient) {
      await setStatus(admin, row.id, "failed", "no provider/recipient");
      summary.failed++;
      continue;
    }
    const result = await provider.send(payload.recipient, {
      text: payload.text ?? "",
      html: payload.html,
    });
    const status: "sent" | "skipped" | "failed" =
      result.outcome === "sent" ? "sent" : result.outcome === "skipped" ? "skipped" : "failed";
    if (status === "sent") {
      await setStatus(admin, row.id, "sent", undefined, true);
      summary.sent++;
    } else if (status === "skipped") {
      await setStatus(admin, row.id, "skipped", result.skipReason);
      summary.skipped++;
    } else {
      await setStatus(admin, row.id, "failed", result.errorMessage);
      summary.failed++;
    }

    // Reflect the retry outcome on the report row.
    if (payload.key && payload.kind) {
      const table = payload.kind === "year" ? "yearly_reports" : "monthly_reports";
      const keyCol = payload.kind === "year" ? "year_key" : "month_key";
      const channels = [{ channel: "telegram" as const, at: new Date().toISOString(), status }];
      await admin
        .from(table)
        .update({ delivered_channels_json: channels as unknown as Json })
        .eq("user_id", row.user_id)
        .eq(keyCol as never, payload.key);
    }
  }
}

/**
 * GET — the daily reports sweep.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron injects it). 401
 * otherwise. `?dry=1` derives + returns what WOULD generate/send, writes nothing.
 * Service-role sweep across every report-enabled user (no user cookie). Generates
 * a statement for the just-closed period (catch-up window: first 3 days of the
 * new month, per-user timezone) when none exists yet; delivers a Telegram
 * highlight to linked+enabled users. Whole body wrapped in try/catch → structured
 * JSON, never Next's HTML error page.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "server not configured (service role missing)" },
      { status: 503 },
    );
  }

  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const summary: Summary = {
    users: 0,
    monthlyGenerated: 0,
    yearlyGenerated: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retriesAttempted: 0,
    truncated: 0,
  };
  const dryReports: DryReportItem[] = [];
  const startedAt = Date.now();

  try {
    const admin = createSupabaseAdminClient();
    let page = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() - startedAt > SOFT_BUDGET_MS) {
        summary.truncated++;
        break;
      }

      const from = page * PAGE_SIZE;
      const { data: profiles, error: pErr } = await admin
        .from("user_profiles")
        .select(
          "user_id, timezone, telegram_chat_id, telegram_enabled, monthly_report_enabled, yearly_report_enabled",
        )
        .or("monthly_report_enabled.eq.true,yearly_report_enabled.eq.true")
        .order("user_id")
        .range(from, from + PAGE_SIZE - 1);
      if (pErr) throw new Error(`profiles: ${pErr.message}`);
      const rows = (profiles ?? []) as unknown as ProfileRow[];
      if (rows.length === 0) break;

      // Resolve each profile's period + telegram eligibility ONCE.
      interface Resolved {
        userId: string;
        todayISO: string;
        inWindow: boolean;
        month: string;
        year: string | null;
        telOk: boolean;
        chatId: string | null;
        monthly: boolean;
        yearly: boolean;
      }
      const resolved: Resolved[] = rows.map((p) => {
        const todayISO = todayISOFor(p.timezone);
        const telOk = !!p.telegram_chat_id && !!p.telegram_enabled;
        summary.users++;
        return {
          userId: p.user_id,
          todayISO,
          inWindow: withinGenerationWindow(todayISO, 3),
          month: prevMonthKeyFromToday(todayISO),
          year: parseISODate(todayISO).getMonth() === 0 ? prevYearKeyFromToday(todayISO) : null,
          telOk,
          chatId: p.telegram_chat_id,
          monthly: p.monthly_report_enabled,
          yearly: p.yearly_report_enabled,
        };
      });

      const active = resolved.filter((r) => r.inWindow);

      // Batched existence checks, grouped by covered key (usually one key/page).
      const needMonthly = new Map<string, string[]>(); // monthKey → userIds
      const needYearly = new Map<string, string[]>(); // yearKey → userIds
      for (const r of active) {
        if (!r.monthly) continue;
        const arr = needMonthly.get(r.month) ?? [];
        arr.push(r.userId);
        needMonthly.set(r.month, arr);
      }
      for (const r of active) {
        if (!r.yearly || !r.year) continue;
        const arr = needYearly.get(r.year) ?? [];
        arr.push(r.userId);
        needYearly.set(r.year, arr);
      }

      const pendingMonthly = new Set<string>();
      for (const [monthKey, userIds] of needMonthly) {
        const have = await existingKeys(admin, "monthly_reports", "month_key", monthKey, userIds);
        for (const uid of userIds) if (!have.has(uid)) pendingMonthly.add(uid);
      }
      const pendingYearly = new Set<string>();
      for (const [yearKey, userIds] of needYearly) {
        const have = await existingKeys(admin, "yearly_reports", "year_key", yearKey, userIds);
        for (const uid of userIds) if (!have.has(uid)) pendingYearly.add(uid);
      }

      const usersNeedingSubs = new Set<string>([...pendingMonthly, ...pendingYearly]);
      const subsByUser =
        usersNeedingSubs.size > 0 ? await fetchSubsByUser(admin, [...usersNeedingSubs]) : new Map();

      const infoByUser = new Map(resolved.map((r) => [r.userId, r]));

      // Generate + deliver PER USER (not all-generate-then-all-deliver), so a
      // mid-page crash can strand at most ONE user's delivery, never a page's
      // worth. And `dry` gates the upserts: a dry run writes NOTHING — it only
      // records what would generate/send (the plan's own docstring promises this).
      for (const uid of usersNeedingSubs) {
        const info = infoByUser.get(uid);
        if (!info) continue;
        const plans: ReportDeliveryPlan[] = [];

        if (pendingMonthly.has(uid)) {
          if (dry) {
            summary.monthlyGenerated++;
            dryReports.push({ userId: uid, key: info.month, kind: "month", recipient: info.chatId });
          } else {
            const totals = buildMonthlyReport(subsByUser.get(uid) ?? [], info.month, info.todayISO);
            const { data } = await admin
              .from("monthly_reports")
              .upsert(
                {
                  user_id: uid,
                  month_key: info.month,
                  totals_json: totals as unknown as Json,
                  report_html: renderMonthlyReportHTML(totals),
                },
                { onConflict: "user_id,month_key", ignoreDuplicates: true },
              )
              .select("id");
            const inserted = (data ?? []) as { id: string }[];
            if (inserted.length === 0) continue; // a concurrent run just created it
            summary.monthlyGenerated++;
            if (info.telOk) {
              plans.push({
                table: "monthly_reports",
                rowId: inserted[0].id,
                userId: uid,
                key: info.month,
                kind: "month",
                message: buildMonthlyReportMessage(totals, appUrl),
              });
            }
          }
        }

        if (pendingYearly.has(uid) && info.year) {
          if (dry) {
            summary.yearlyGenerated++;
            dryReports.push({ userId: uid, key: info.year, kind: "year", recipient: info.chatId });
          } else {
            const totals = buildYearlyReport(subsByUser.get(uid) ?? [], info.year, info.todayISO);
            const { data } = await admin
              .from("yearly_reports")
              .upsert(
                {
                  user_id: uid,
                  year_key: info.year,
                  totals_json: totals as unknown as Json,
                  report_html: renderYearlyReportHTML(totals),
                },
                { onConflict: "user_id,year_key", ignoreDuplicates: true },
              )
              .select("id");
            const inserted = (data ?? []) as { id: string }[];
            if (inserted.length === 0) continue;
            summary.yearlyGenerated++;
            if (info.telOk) {
              plans.push({
                table: "yearly_reports",
                rowId: inserted[0].id,
                userId: uid,
                key: info.year,
                kind: "year",
                message: buildYearlyReportMessage(totals, appUrl),
              });
            }
          }
        }

        // Deliver THIS user's plans before moving on (only in a real run).
        if (!dry) {
          for (const plan of plans) {
            if (!info.chatId) {
              summary.skipped++;
              continue;
            }
            await deliverOne(admin, plan, info.chatId, dry, summary, dryReports);
          }
        }
      }

      page++;
      if (rows.length < PAGE_SIZE) break; // last page
    }

    if (!dry) {
      // The retry-eligibility set must be COMPLETE and independent of paging /
      // report flags: a truncated sweep never visited later pages, and a user
      // may have disabled reports after a delivery failed. Building it from a
      // dedicated query (telegram linked+enabled) avoids falsely skipping
      // (terminal) a legitimately failed report delivery.
      const telegramEligible = await fetchTelegramEligible(admin);
      await retryFailed(admin, telegramEligible, summary);
    }

    // Ops alert: exactly one fire when something needs paging.
    if (!dry && (summary.failed > 0 || summary.truncated > 0)) {
      await sendOpsAlert(
        `failed=${summary.failed} truncated=${summary.truncated} sent=${summary.sent} ` +
          `monthlyGenerated=${summary.monthlyGenerated} yearlyGenerated=${summary.yearlyGenerated}`,
      );
    }

    const body = {
      ok: true,
      dry,
      ...summary,
      ...(dry ? { reports: dryReports.slice(0, DRY_SAMPLE_CAP) } : {}),
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error("[cron/reports] sweep failed:", e);
    const msg = e instanceof Error ? e.message : "sweep failed";
    if (!dry) await sendOpsAlert(`sweep threw: ${msg}`).catch(() => {});
    return NextResponse.json({ ok: false, error: msg, dry, ...summary }, { status: 500 });
  }
}
