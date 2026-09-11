import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { resolveBridgeUserId } from "@/lib/claude-usage/bridge-auth";
import { bodySchema, type UsageStream } from "@/lib/claude-usage/protocol";
import { mergeUsageStreams } from "@/lib/claude-usage/stream-continuity";
import type { Json } from "@/lib/supabase/types";
import { CODEX_ACCOUNT_SLOTS } from "@/lib/claude-usage/codex-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Explicit function deadline. The DB client has its own 8s timeout, so the
// route returns well before this — but declaring it keeps the platform from
// applying a shorter default that could race a slow (but still <8s) request.
export const maxDuration = 20;

/**
 * Shallow-copy an object minus the named keys (for graceful column fallback).
 * `keys` are optional JSON columns, so the result still satisfies the Insert
 * type — hence the preserved `T` shape (a runtime lie about the dropped keys,
 * but they're all optional in the schema).
 */
function without<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  const out = { ...obj };
  for (const k of keys) delete out[k as keyof T];
  return out;
}

async function persistCodexMetadata(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  streams: readonly UsageStream[],
  observedAt: string,
  deviceId: string | null,
): Promise<void> {
  const rows = streams.flatMap((stream) => {
    if (stream.source !== "codex" || !stream.account_key) return [];
    const slot = CODEX_ACCOUNT_SLOTS.find((candidate) => candidate.account_key === stream.account_key);
    if (!slot) return [];
    return [{
      user_id: userId,
      account_key: slot.account_key,
      slot: slot.slot,
      label: slot.label,
      email: stream.account_email ?? null,
      member_id: stream.member_id ?? null,
      workspace_id: stream.workspace_id ?? null,
      workspace_name: stream.workspace_name ?? null,
      plan_type: stream.plan_type ?? null,
      status: "connected" as const,
      device_id: deviceId,
      last_seen_at: observedAt,
    }];
  });
  if (rows.length > 0) {
    const { error } = await admin.from("codex_accounts").upsert(rows, { onConflict: "user_id,account_key" });
    if (error && !/codex_accounts|relation|column/i.test(error.message)) {
      console.error("[claude-usage/ingest] account metadata error:", error.message);
    }
  }
  if (deviceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    const codexRows = streams.filter((stream) => stream.source === "codex" && stream.account_key);
    if (codexRows.length > 0) {
      const { error } = await admin.from("codex_devices").upsert({
        id: deviceId,
        user_id: userId,
        device_name: "DuitSini Desktop",
        protocol_version: 1,
        switch_supported: false,
        heartbeat_at: observedAt,
        generation: 0,
        updated_at: observedAt,
      }, { onConflict: "id" });
      if (error && !/codex_devices|relation|column/i.test(error.message)) {
        console.error("[claude-usage/ingest] device metadata error:", error.message);
      }
    }
  }
}

/**
 * Ingest endpoint for the local Claude Usage Bridge. Authenticated by a shared
 * secret (NOT a user session) so the companion can push without cookies. Writes
 * one snapshot row via the service role. The target user is pinned by
 * CLAUDE_BRIDGE_USER_ID when set (recommended), else taken from the body.
 */
export async function POST(req: NextRequest) {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Live bridge not configured on the server." },
      { status: 503 },
    );
  }
  // Catch EVERYTHING — a throw (malformed env, abort on DB timeout, an
  // unexpected TypeError) must become a structured JSON response the bridge can
  // retry on, never Next's production HTML error page (which is what surfaced
  // as "Sending to dashboard failed (500): <!DOCTYPE html…").
  try {
    const targetUser = await resolveBridgeUserId(req.headers.get("authorization"));
    if (!targetUser) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });
    }

    const { five_hour, seven_day, limits, provider, streams, push_seconds, sharer_version } =
      parsed.data;

    // Server time for this push. Stamps the row-wide `updated_at` and backfills
    // `observed_at` on any incoming stream missing it (legacy single-source
    // wrap, or a producer that forgot). Guaranteeing every stored stream has a
    // reliable `observed_at` is what lets stream-continuity bound how long an
    // omitted source is preserved instead of keeping a stale ghost forever.
    const nowMs = Date.now();
    const observedAt = new Date(nowMs).toISOString();
    // Normalize to a streams array — the UI reads from streams_json. Newer
    // bridges send `streams`; a legacy single-source push is wrapped so the row
    // still carries the new shape.
    const incoming = (
      streams && streams.length > 0
        ? streams
        : ([
            {
              source: "claude",
              label: "Claude",
              five_hour,
              seven_day,
              limits: limits ?? null,
              provider: provider ?? null,
            },
          ] as UsageStream[])
    ).map((s) => {
      const parsedObserved = s.observed_at ? Date.parse(s.observed_at) : Number.NaN;
      // A producer clock can drift, but a far-future timestamp would keep a
      // stale account looking fresh indefinitely. Keep only a small skew.
      const normalizedStream = !Number.isFinite(parsedObserved) || parsedObserved > nowMs + 5 * 60_000
        ? { ...s, observed_at: observedAt }
        : s;
      // A bridge token authenticates the DuitSini owner, but it does not make
      // an arbitrary account_key valid. Unknown Codex identities remain an
      // anonymous legacy reading rather than being allowed to impersonate a
      // registered card.
      if (
        normalizedStream.source === "codex" &&
        normalizedStream.account_key &&
        !CODEX_ACCOUNT_SLOTS.some((slot) => slot.account_key === normalizedStream.account_key)
      ) {
        return {
          ...normalizedStream,
          account_key: undefined,
          account_email: null,
          member_id: null,
          workspace_id: null,
          workspace_name: null,
          plan_type: null,
        };
      }
      return normalizedStream;
    });

    const admin = createSupabaseAdminClient();
    // An ingest upsert replaces streams_json wholesale. Read the prior JSON so
    // a single collector failure cannot silently delete one of the three agent
    // sections. A missing/legacy column simply skips this enhancement.
    const { data: previous } = await admin
      .from("claude_usage_live")
      .select("streams_json")
      .eq("user_id", targetUser)
      .maybeSingle();
    const normalized = mergeUsageStreams(
      incoming,
      Array.isArray(previous?.streams_json) ? previous.streams_json : null,
      nowMs,
    );

    // The "primary" stream mirrors into the legacy scalar columns so older
    // servers/readers keep working. Prefer a Claude-subscription source so the
    // legacy single-gauge widget shows real account usage rather than a gateway.
    const primary =
      normalized.find((s) => s.source === "claude_pro" || s.source === "claude") ??
      normalized[0];
    const deviceId = normalized.find((s) => s.device_id)?.device_id ?? null;

    // Try the full row; if a JSON column's migration isn't applied yet, retry
    // progressively without the offending column(s) so the widget keeps working.
    // (The live DB has all columns; this only matters for self-hosted copies
    // that haven't run the later migrations.)
    const full = {
      user_id: targetUser,
      five_hour_utilization: primary.five_hour?.utilization ?? null,
      five_hour_resets_at: primary.five_hour?.resets_at ?? null,
      seven_day_utilization: primary.seven_day?.utilization ?? null,
      seven_day_resets_at: primary.seven_day?.resets_at ?? null,
      updated_at: observedAt,
      device_id: deviceId,
      streams_json: normalized as unknown as Json,
      limits_json: (primary.limits ?? null) as Json,
      provider_json: (primary.provider ?? null) as Json,
      push_seconds: push_seconds ?? null,
      sharer_version: sharer_version ?? null,
    };

    // New installations use the locked RPC so concurrent desktop profiles
    // cannot overwrite one another's account stream. Older/self-hosted copies
    // may not have the additive function yet; retain the guarded compatibility
    // upsert below until that migration is applied.
    const { error: atomicError } = await admin.rpc("merge_claude_usage_live", {
      p_user_id: targetUser,
      p_five_hour_utilization: full.five_hour_utilization,
      p_five_hour_resets_at: full.five_hour_resets_at,
      p_seven_day_utilization: full.seven_day_utilization,
      p_seven_day_resets_at: full.seven_day_resets_at,
      p_updated_at: full.updated_at,
      p_device_id: full.device_id,
      p_streams_json: full.streams_json,
      p_limits_json: full.limits_json,
      p_provider_json: full.provider_json,
      p_push_seconds: full.push_seconds,
      p_sharer_version: full.sharer_version,
    });
    if (!atomicError) {
      await persistCodexMetadata(admin, targetUser, normalized, observedAt, deviceId);
      return NextResponse.json({ ok: true, atomic: true });
    }
    if (!/function|schema cache|does not exist|merge_claude_usage_live/i.test(atomicError.message)) {
      console.error("[claude-usage/ingest] atomic merge error:", atomicError.message);
      return NextResponse.json({ ok: false, error: atomicError.message }, { status: 500 });
    }

    let { error } = await admin.from("claude_usage_live").upsert(full);
    if (error && /device_id|push_seconds|sharer_version/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(without(full, ["device_id", "push_seconds", "sharer_version"])));
    }
    if (error && /streams_json/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(without(full, ["device_id", "push_seconds", "sharer_version", "streams_json"])));
    }
    if (error && /provider_json/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(without(full, ["device_id", "push_seconds", "sharer_version", "streams_json", "provider_json"])));
    }
    if (error && /limits_json/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(
          without(full, [
            "push_seconds",
            "sharer_version",
            "device_id",
            "streams_json",
            "provider_json",
            "limits_json",
          ]),
        ));
    }
    if (error) {
      console.error("[claude-usage/ingest] db error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    await persistCodexMetadata(admin, targetUser, normalized, observedAt, deviceId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // The DB client's 8s timeout aborts a stalled upsert as an AbortError here,
    // so a Supabase hang becomes a fast JSON 500 (bridge retries in 15s) rather
    // than hanging until the platform kills the function.
    console.error("[claude-usage/ingest] unhandled error:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
