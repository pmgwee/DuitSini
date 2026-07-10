import { type NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { rowToSubscription } from "@/lib/data/supabase/supabase-repo";
import type { Database, Json } from "@/lib/supabase/types";
import type { Subscription, NotificationChannel } from "@/types/subscription";
import {
  deriveDueReminders,
  reminderDedupeKey,
  sanitizeOffsets,
  type DueReminder,
} from "@/lib/reminders/engine";
import { getProvider, type NotifyPayload } from "@/lib/notify";
import { buildDigestMessage } from "@/lib/notify/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The sweep touches the DB once per user + once per digest; 60s is headroom
// for a growing user base on the daily cron.
export const maxDuration = 60;

const FALLBACK_TZ = "Asia/Kuala_Lumpur";
const RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;
// A failed digest must be at least this old before retryFailed re-attempts it:
// gives transient errors (a 5xx blip, a brief 429) a real backoff, and excludes
// rows the derive pass inserted/failed seconds earlier in THIS invocation.
const RETRY_MIN_AGE_MS = 10 * 60 * 1000;
const DRY_SAMPLE_CAP = 50;

type DeliveryStatus = Database["public"]["Enums"]["delivery_status"];
type DeliveryUpdate = Database["public"]["Tables"]["notification_deliveries"]["Update"];

interface Summary {
  users: number;
  derived: number;
  digests: number;
  sent: number;
  skipped: number;
  failed: number;
  retriesAttempted: number;
}

/** Authorize via the shared CRON_SECRET Vercel Cron injects as a bearer token. */
function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Civil "today" (YYYY-MM-DD) in the given IANA timezone; falls back to MY time. */
function todayISOFor(timezone: string | null | undefined): string {
  const zone = timezone && timezone.trim() ? timezone.trim() : FALLBACK_TZ;
  const opts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: zone, ...opts }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: FALLBACK_TZ, ...opts }).format(new Date());
  }
}

interface DigestItem {
  name: string;
  kind: string;
  chargeISO: string;
  offsetDays: number;
}

interface DigestPayload {
  digest: true;
  text: string;
  html?: string;
  recipient: string;
  /** Civil date these reminders are FOR (drives idempotency + the audit label). */
  date: string;
  /**
   * Reminder dedupe keys this digest covered (sub × channel × offset × charge).
   * The NEXT run unions these across every prior row for the same due date to
   * decide what's still "new" — so a subscription added after the morning
   * digest already went out still gets reminded, without re-sending anything.
   */
  coveredKeys?: string[];
  items: DigestItem[];
}

interface DeliveryRowLite {
  id: string;
  channel: NotificationChannel;
  payload_json: Json | null;
}

async function setStatus(
  admin: SupabaseClient<Database>,
  id: string,
  status: DeliveryStatus,
  errorMessage?: string,
  markSent = false,
): Promise<void> {
  const patch: DeliveryUpdate = { status, error_message: errorMessage ?? null };
  if (markSent) patch.sent_at = new Date().toISOString();
  await admin.from("notification_deliveries").update(patch).eq("id", id);
}

/**
 * Send a (pending) ledger row via its channel provider and record the outcome.
 * Never throws — a bad recipient or a provider outage is a per-row failure, not
 * a sweep killer. Works for both digest rows and (legacy) single rows: it only
 * needs payload.recipient + payload.text/html.
 */
async function sendAndUpdate(
  admin: SupabaseClient<Database>,
  row: DeliveryRowLite,
  summary: Summary,
): Promise<void> {
  const provider = getProvider(row.channel);
  const payload = (row.payload_json ?? {}) as Partial<DigestPayload>;

  if (!provider) {
    await setStatus(admin, row.id, "skipped", "no provider for channel");
    summary.skipped++;
    return;
  }
  if (!provider.isConfigured()) {
    await setStatus(admin, row.id, "skipped", `${row.channel} not configured`);
    summary.skipped++;
    return;
  }
  if (!payload.recipient) {
    await setStatus(admin, row.id, "skipped", "no recipient");
    summary.skipped++;
    return;
  }

  const np: NotifyPayload = { text: payload.text ?? "", html: payload.html };
  const result = await provider.send(payload.recipient, np);
  if (result.outcome === "sent") {
    await setStatus(admin, row.id, "sent", undefined, true);
    summary.sent++;
  } else if (result.outcome === "skipped") {
    await setStatus(admin, row.id, "skipped", result.skipReason);
    summary.skipped++;
  } else {
    await setStatus(admin, row.id, "failed", result.errorMessage);
    summary.failed++;
  }
}

/**
 * Deliver ONE daily digest for a user: all NEW reminders sharing `dueISO`, sent
 * as a single Telegram message (the anti-spam fix — one morning message, not N).
 *
 * Idempotency is per REMINDER (sub × channel × offset × charge), not per due
 * date. A subscription added AFTER the morning digest already went out must
 * still be reminded, so we look at every digest row ever written for this
 * (user, channel, due date) and union the reminder keys each covered (stored in
 * payload.coveredKeys). Reminders not yet covered are "fresh" and earn a new
 * digest — keyed by a hash of their keys, so the unique index permits one row
 * per distinct reminder-set per due date. Re-runs with no new reminders find
 * everything covered and send nothing (idempotent); a late-added "ggg" sends in
 * its own message without re-sending reminders that already went out.
 *
 * Recovering FAILED/pending digests is retryFailed's job (it resends the exact
 * stored message), so this function only ever INSERTs new content — it never
 * claims or mutates an existing row. Concurrency is handled by the unique index
 * on dedupe_key: two runs computing the same fresh key-set race to insert, the
 * loser gets a 23505 and skips.
 */
async function deliverDigest(
  admin: SupabaseClient<Database>,
  userId: string,
  chatId: string,
  dueISO: string,
  reminders: DueReminder[],
  todayISO: string,
  dry: boolean,
  summary: Summary,
  dryReminders: DueReminder[],
  dryBundles: { dueISO: string; count: number; names: string[] }[],
): Promise<void> {
  const channel: NotificationChannel = "telegram";

  if (dry) {
    dryReminders.push(...reminders);
    dryBundles.push({
      dueISO,
      count: reminders.length,
      names: reminders.map((r) => r.name),
    });
    return;
  }

  const keyOf = (r: DueReminder) =>
    reminderDedupeKey(r.subscriptionId, channel, r.offsetDays, r.chargeISO);

  // Union every reminder key already covered by a prior digest for this due
  // date (any status — a failed/pending row's keys are "claimed" and retried by
  // retryFailed, not re-derived here). Prefix-match keeps it to one due date;
  // the literal segments (uuid / "telegram" / iso date) contain no LIKE
  // wildcards, so only the trailing % is special.
  const prefix = `${userId}:${channel}:digest:${dueISO}:`;
  const { data: prior } = await admin
    .from("notification_deliveries")
    .select("payload_json")
    .like("dedupe_key", `${prefix}%`);
  const covered = new Set<string>();
  for (const row of (prior ?? []) as unknown as { payload_json: Json | null }[]) {
    const pj = (row.payload_json ?? {}) as Partial<DigestPayload>;
    if (Array.isArray(pj.coveredKeys)) for (const k of pj.coveredKeys) covered.add(k);
  }

  const fresh = reminders.filter((r) => !covered.has(keyOf(r)));
  if (fresh.length === 0) {
    // Everything for this due date already went out (or is in flight) — no-op.
    summary.skipped++;
    return;
  }

  const freshKeys = fresh.map(keyOf);
  // Fold the exact covered-reminder keys into the dedupe key (sorted, so the
  // same set is stable regardless of derivation order). The unique index then
  // allows one row per DISTINCT reminder-set per due date — collision-free, so
  // two genuinely different sets (e.g. after a schedule change adds an offset)
  // can never be mistaken for the same digest.
  const dedupeKey = `${prefix}${[...freshKeys].sort().join(",")}`;
  const msg = buildDigestMessage(fresh, todayISO, dueISO);
  const payload: DigestPayload = {
    digest: true,
    text: msg.text,
    html: msg.html,
    recipient: chatId,
    date: dueISO,
    coveredKeys: freshKeys,
    items: fresh.map((r) => ({
      name: r.name,
      kind: r.kind,
      chargeISO: r.chargeISO,
      offsetDays: r.offsetDays,
    })),
  };
  const payloadJson = payload as unknown as Json;

  // A digest spans multiple subscriptions, so subscription_id is null.
  const insert = {
    user_id: userId,
    subscription_id: null,
    channel,
    scheduled_for: new Date().toISOString(),
    status: "pending" as DeliveryStatus,
    payload_json: payloadJson,
    dedupe_key: dedupeKey,
  };
  const { data: inserted, error } = await admin
    .from("notification_deliveries")
    .insert(insert)
    .select("id")
    .single();
  if (error || !inserted) {
    // 23505 unique_violation (a concurrent run just created the same content
    // digest) → skip cleanly.
    summary.skipped++;
    return;
  }
  summary.digests++;
  await sendAndUpdate(admin, { id: inserted.id, channel, payload_json: payloadJson }, summary);
}

/**
 * Re-attempt digests that failed within the retry window. Self-contained: the
 * recipient + message are read back from payload_json, so no re-derivation is
 * needed. Guards: recency floor (real backoff + excludes rows deliverDigest
 * inserted seconds ago in THIS invocation), `enabledUserIds` (honor the disable
 * toggle), atomic claim (only resend if still `failed`). deliverDigest only
 * inserts NEW content and never mutates existing rows, so there's nothing for
 * it to "hand off" here — the age floor alone excludes this run's fresh rows.
 */
async function retryFailed(
  admin: SupabaseClient<Database>,
  enabledUserIds: Set<string>,
  summary: Summary,
): Promise<void> {
  const now = Date.now();
  const since = new Date(now - RETRY_WINDOW_MS).toISOString();
  const minAge = new Date(now - RETRY_MIN_AGE_MS).toISOString();

  // Recover rows stuck at 'pending' by a run that crashed between claiming and
  // sending: deliverDigest only re-claims 'failed' rows, so a stuck 'pending'
  // would otherwise never resend. Reclassify stale ones (older than the age
  // floor) to 'failed' so the failed-retry below picks them up. Fresh 'pending'
  // rows — being sent by a concurrent run right now — are under the floor and
  // untouched (and also guarded by `touched`).
  await admin
    .from("notification_deliveries")
    .update({ status: "failed" as DeliveryStatus, error_message: "recovered from stuck pending" })
    .eq("status", "pending")
    .lt("scheduled_for", minAge);

  const { data: failed, error } = await admin
    .from("notification_deliveries")
    .select("id, user_id, channel, payload_json")
    .eq("status", "failed")
    .gte("scheduled_for", since)
    .lt("scheduled_for", minAge);
  if (error || !failed) return;

  for (const row of failed as unknown as (DeliveryRowLite & { user_id: string })[]) {
    // Honor the disable gate: if the user turned reminders off (or unlinked)
    // since this digest failed, don't resend — mark it skipped with a reason.
    if (!enabledUserIds.has(row.user_id)) {
      await setStatus(admin, row.id, "skipped", "reminders disabled");
      summary.skipped++;
      continue;
    }

    const { data: claimed } = await admin
      .from("notification_deliveries")
      .update({ status: "pending" as DeliveryStatus, error_message: null })
      .eq("id", row.id)
      .in("status", ["failed"])
      .select("id");
    if (!claimed || claimed.length === 0) continue;

    summary.retriesAttempted++;
    await sendAndUpdate(admin, row, summary);
  }
}

/**
 * GET — the daily reminders sweep.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (Vercel Cron injects it). 401
 * otherwise. `?dry=1` derives + returns what WOULD send, but sends/writes
 * nothing. Service-role sweep across every Telegram-enabled user (no user
 * cookie). Whole body wrapped in try/catch → structured JSON, never Next's HTML
 * error page.
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
  const summary: Summary = {
    users: 0,
    derived: 0,
    digests: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retriesAttempted: 0,
  };
  const dryReminders: DueReminder[] = [];
  const dryBundles: { dueISO: string; count: number; names: string[] }[] = [];
  const enabledUserIds = new Set<string>();

  try {
    const admin = createSupabaseAdminClient();

    // Candidates: users who enabled Telegram AND have a linked chat_id. This set
    // is also the disable-gate retryFailed re-checks.
    const { data: profiles, error: pErr } = await admin
      .from("user_profiles")
      .select(
        "user_id, timezone, telegram_chat_id, telegram_enabled, reminder_offsets_days",
      )
      .eq("telegram_enabled", true)
      .not("telegram_chat_id", "is", null);
    if (pErr) throw new Error(`profiles: ${pErr.message}`);

    for (const p of profiles ?? []) {
      enabledUserIds.add(p.user_id as string);
      summary.users++;
      const chatId = p.telegram_chat_id as string;
      const todayISO = todayISOFor(p.timezone as string | null);

      const { data: rows, error: sErr } = await admin
        .from("subscriptions")
        .select("*")
        .eq("user_id", p.user_id);
      if (sErr) {
        console.error("[cron/reminders] subs fetch failed", p.user_id, sErr.message);
        continue;
      }

      const subs = (rows ?? []).map(rowToSubscription) as Subscription[];
      // The global default applies to subs that haven't customized (NULL =
      // "inherit"); a per-sub override wins where set. Resolve BEFORE the pure
      // engine runs so the engine stays untouched.
      const globalOffsets = sanitizeOffsets(p.reminder_offsets_days);
      const effective = subs.map((s) => ({
        ...s,
        reminderOffsetsDays:
          s.reminderOffsetsDays == null ? globalOffsets : s.reminderOffsetsDays,
      }));
      const reminders = deriveDueReminders(effective, todayISO);
      summary.derived += reminders.length;

      // Collapse catch-up duplicates: the [yesterday, today] window can put TWO
      // offsets for the SAME charge due in one run (a charge landing today has
      // both its 1-day-before and same-day reminder due). From today's vantage
      // they describe the same event, and since the message is built from the
      // charge (not the offset) both would render the identical line — one as a
      // standalone message, one nested in today's digest. Keep only the most
      // imminent (smallest offset, i.e. due today) per (subscription, charge),
      // so the reminder consolidates into today's digest instead of repeating.
      const imminent = new Map<string, DueReminder>();
      for (const r of reminders) {
        const key = `${r.subscriptionId}:${r.chargeISO}`;
        const prev = imminent.get(key);
        if (!prev || r.offsetDays < prev.offsetDays) imminent.set(key, r);
      }
      summary.skipped += reminders.length - imminent.size;

      // Channel gate: keep only reminders whose sub lists telegram (on by
      // default for new subs). The rest are intentionally opted out — counted
      // but not delivered or audited.
      const deliverable = [...imminent.values()].filter((r) => {
        const sub = subs.find((s) => s.id === r.subscriptionId);
        return sub?.notificationChannels.includes("telegram");
      });
      summary.skipped += imminent.size - deliverable.length;

      // Group by due date → one digest per (user, due date). Normal daily run =
      // one group (today) = one message. A missed day yields a separate digest
      // for that due date (keyed apart, so no cross-day duplicates).
      const byDue = new Map<string, DueReminder[]>();
      for (const r of deliverable) {
        const arr = byDue.get(r.dueISO);
        if (arr) arr.push(r);
        else byDue.set(r.dueISO, [r]);
      }

      for (const [dueISO, group] of byDue) {
        await deliverDigest(
          admin,
          p.user_id,
          chatId,
          dueISO,
          group,
          todayISO,
          dry,
          summary,
          dryReminders,
          dryBundles,
        );
      }
    }

    if (!dry) {
      await retryFailed(admin, enabledUserIds, summary);
    }

    const body = {
      ok: true,
      dry,
      ...summary,
      ...(dry
        ? {
            reminders: dryReminders.slice(0, DRY_SAMPLE_CAP),
            bundles: dryBundles,
          }
        : {}),
    };
    return NextResponse.json(body);
  } catch (e) {
    console.error("[cron/reminders] sweep failed:", e);
    const msg = e instanceof Error ? e.message : "sweep failed";
    return NextResponse.json({ ok: false, error: msg, dry, ...summary }, { status: 500 });
  }
}
