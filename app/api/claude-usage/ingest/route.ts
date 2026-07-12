import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { resolveBridgeUserId } from "@/lib/claude-usage/bridge-auth";
import type { Json } from "@/lib/supabase/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Explicit function deadline. The DB client has its own 8s timeout, so the
// route returns well before this — but declaring it keeps the platform from
// applying a shorter default that could race a slow (but still <8s) request.
export const maxDuration = 20;

const windowSchema = z
  .object({
    utilization: z.number().min(0).max(1000).nullable(),
    resets_at: z.string().min(1).max(64).nullable(),
  })
  .nullable();

const limitSchema = z.object({
  key: z.string().max(64),
  label: z.string().max(80),
  group: z.enum(["session", "weekly"]),
  percent: z.number().min(0).max(1000).nullable(),
  resets_at: z.string().max(64).nullable(),
  severity: z.string().max(32).nullable().optional(),
});

const providerSchema = z
  .object({
    name: z.string().max(80).nullable(),
    gateway_host: z.string().max(120).nullable(),
    official: z.boolean(),
  })
  .nullable();

// One usage stream (e.g. Claude Pro from a dedicated subscription login, or
// GLM from a cc-switch-routed Claude Code CLI). A bridge can push several at
// once so the dashboard shows more than one account/plan live at the same time.
const streamSchema = z.object({
  source: z.string().min(1).max(32),
  label: z.string().min(1).max(80),
  five_hour: windowSchema.optional(),
  seven_day: windowSchema.optional(),
  limits: z.array(limitSchema).max(40).nullable().optional(),
  provider: providerSchema.optional(),
});

const bodySchema = z.object({
  user_id: z.string().uuid().optional(),
  five_hour: windowSchema.optional(),
  seven_day: windowSchema.optional(),
  limits: z.array(limitSchema).max(40).nullable().optional(),
  // Which cc-switch provider was active on the sender's machine when this
  // snapshot was taken — purely informational (see bridge-auth.ts / bridge
  // README). Absent for older bridge scripts that predate this field.
  provider: providerSchema.optional(),
  // Multi-source push: every available usage stream this cycle. Newer bridges
  // send this; the legacy top-level fields above stay populated (mirroring the
  // primary stream) so older servers/readers keep working.
  streams: z.array(streamSchema).max(6).optional(),
  // Self-reported push cadence (sharer v6.2+): lets the live route size its
  // freshness window to the producer instead of a hardcoded constant. Bounds
  // mirror the sharer's own clamp (120–3600) with slack for future changes.
  push_seconds: z.number().int().min(60).max(7200).optional(),
  sharer_version: z.string().max(16).optional(),
});

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
    const normalized =
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

    // The "primary" stream mirrors into the legacy scalar columns so older
    // servers/readers keep working. Prefer a Claude-subscription source so the
    // legacy single-gauge widget shows real account usage rather than a gateway.
    const primary =
      normalized.find((s) => s.source === "claude_pro" || s.source === "claude") ??
      normalized[0];

    const admin = createSupabaseAdminClient();

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
