import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { resolveBridgeUserId } from "@/lib/claude-usage/bridge-auth";
import { bodySchema } from "@/lib/claude-usage/protocol";
import { mergeUsageStreams } from "@/lib/claude-usage/stream-continuity";
import type { Json } from "@/lib/supabase/types";

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

    // Normalize to a streams array — the UI reads from streams_json. Newer
    // bridges send `streams`; a legacy single-source push is wrapped so the row
    // still carries the new shape.
    const incoming =
      streams && streams.length > 0
        ? streams
        : [
            {
              source: "claude",
              label: "Claude",
              five_hour,
              seven_day,
              limits: limits ?? null,
              provider: provider ?? null,
            },
          ];

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
    );

    // The "primary" stream mirrors into the legacy scalar columns so older
    // servers/readers keep working. Prefer a Claude-subscription source so the
    // legacy single-gauge widget shows real account usage rather than a gateway.
    const primary =
      normalized.find((s) => s.source === "claude_pro" || s.source === "claude") ??
      normalized[0];

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
      updated_at: new Date().toISOString(),
      streams_json: normalized as unknown as Json,
      limits_json: (primary.limits ?? null) as Json,
      provider_json: (primary.provider ?? null) as Json,
      push_seconds: push_seconds ?? null,
      sharer_version: sharer_version ?? null,
    };

    let { error } = await admin.from("claude_usage_live").upsert(full);
    if (error && /push_seconds|sharer_version/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(without(full, ["push_seconds", "sharer_version"])));
    }
    if (error && /streams_json/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(without(full, ["push_seconds", "sharer_version", "streams_json"])));
    }
    if (error && /provider_json/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(without(full, ["push_seconds", "sharer_version", "streams_json", "provider_json"])));
    }
    if (error && /limits_json/i.test(error.message)) {
      ({ error } = await admin
        .from("claude_usage_live")
        .upsert(
          without(full, [
            "push_seconds",
            "sharer_version",
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
