import { z } from "zod";

/**
 * Shared protocol for the Claude-usage bridge (ADR-0004).
 *
 * One source of truth for the snapshot/stream shape that the sharer produces
 * and the ingest / live routes + frontend consume. Previously this shape was
 * declared four independent times (sharer SOURCE, ingest Zod, live `StreamRow`,
 * frontend `UsageStream`). Colocating it here dissolves that duplication.
 *
 * The schemas below are reproduced VERBATIM from the ingest route's v7 Zod
 * schemas (behavior-freeze, ADR-0005 §4) — do not relax or tighten them here
 * without a paired change to the producer.
 */

// ─── Cadence (shared by the sharer's loadPushMs and the live route's window) ───

/**
 * Sharer push-cadence bounds, in seconds. The live route's `staleAfterMs`
 * mirrored these exactly; they now live here as the single source. The ingest
 * route's `push_seconds` field uses a wider band (60–7200, see `bodySchema`)
 * with deliberate slack for future changes — that wider band is intentional
 * and is NOT this clamp.
 */
export const PUSH_SECONDS_MIN = 120;
export const PUSH_SECONDS_MAX = 3600;
export const PUSH_SECONDS_DEFAULT = 300;

/** Grace added on top of two full cycles when sizing the freshness window (ms). */
export const FRESHNESS_GRACE_MS = 60 * 1000;

/** Clamp a push cadence (seconds) to the sharer's bounds. */
export function clampPushSeconds(secs: number): number {
  return Math.min(PUSH_SECONDS_MAX, Math.max(PUSH_SECONDS_MIN, secs));
}

/**
 * How long a snapshot counts as "live", derived from the producer's cadence:
 * two full cycles + grace, so jitter or one failed push never flaps the widget
 * to the manual fallback — only two consecutive missed pushes (a real outage)
 * do. Relocated verbatim from the live route's `staleAfterMs` (v6.2).
 */
export function freshnessWindowMs(pushSeconds: number): number {
  return clampPushSeconds(pushSeconds) * 2 * 1000 + FRESHNESS_GRACE_MS;
}

// ─── Preserved-source expiry (stream continuity) ───

/**
 * How long a previously-seen source is preserved on the dashboard after its
 * collector stops pushing it. Stream continuity keeps a source through a
 * transient outage (bridge asleep, a failed push) as an explicit "Saved"
 * reading, but a source silent this long is a *permanently-removed* collector
 * (e.g. a retired desktop build that used to push Gemini), not a blip — so on
 * the next merge it is dropped instead of lingering as a stale card that only
 * the row-wide `updated_at` refreshes.
 *
 * Wall-clock rather than cadence-derived: it must survive an overnight/weekend
 * offline (transient, should come back) and still clear a retired source within
 * about a day. Tunable — lower it to retire stale sources faster.
 */
export const PRESERVED_SOURCE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True if a preserved source's last reading is too old to keep showing. A
 * missing/unparseable `observed_at` is treated as "keep" (we can't prove the
 * collector is gone); in practice every stream is stamped at ingest, so a truly
 * unknown age is rare.
 */
export function isPreservedSourceStale(
  observedAt: string | null | undefined,
  now: number,
): boolean {
  if (!observedAt) return false;
  const ts = new Date(observedAt).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts > PRESERVED_SOURCE_TTL_MS;
}

// ─── Supported dashboard sources ───

/**
 * The usage sources this dashboard renders — and their display order. The
 * producers emit only these source ids (sharer: claude_pro/glm; desktop:
 * claude/codex/glm; the ingest legacy single-source wrap: claude). A snapshot
 * may carry other sources as stale data from a retired build (e.g. a `gemini`
 * stream pushed once by an old desktop branch); those are dropped before render
 * because this app has no Gemini tracking. One map holds both the allowlist and
 * the sort order so they can't drift apart — add an entry here to support a new
 * provider in every surface at once.
 */
export const SUPPORTED_SOURCES: Readonly<Record<string, number>> = {
  claude_pro: 0,
  claude: 0,
  glm: 1,
  codex: 2,
};

/** True if `source` is a provider this dashboard renders. */
export function isSupportedSource(source: string): boolean {
  return source in SUPPORTED_SOURCES;
}

// ─── Snapshot shape (mirrors the ingest route's v7 Zod schemas verbatim) ───

export const windowSchema = z
  .object({
    utilization: z.number().min(0).max(1000).nullable(),
    resets_at: z.string().min(1).max(64).nullable(),
  })
  .nullable();

export const limitSchema = z.object({
  key: z.string().max(64),
  label: z.string().max(80),
  group: z.enum(["session", "weekly"]),
  percent: z.number().min(0).max(1000).nullable(),
  resets_at: z.string().max(64).nullable(),
  severity: z.string().max(32).nullable().optional(),
});

export const providerSchema = z
  .object({
    name: z.string().max(80).nullable(),
    gateway_host: z.string().max(120).nullable(),
    official: z.boolean(),
  })
  .nullable();

/**
 * One usage stream — e.g. Claude Pro from a dedicated subscription login, or
 * GLM from a cc-switch-routed Claude Code CLI. A bridge can push several at
 * once so the dashboard shows more than one account/plan live at the same time.
 */
export const streamSchema = z.object({
  source: z.string().min(1).max(32),
  label: z.string().min(1).max(80),
  five_hour: windowSchema.optional(),
  seven_day: windowSchema.optional(),
  limits: z.array(limitSchema).max(40).nullable().optional(),
  provider: providerSchema.optional(),
  cached: z.boolean().optional(),
  observed_at: z.string().max(64).nullable().optional(),
  state: z.enum(["live", "cached", "auth_stale", "rate_limited", "offline"]).optional(),
  status_message: z.string().max(200).nullable().optional(),
});

/**
 * The full bridge push body. The legacy top-level fields (five_hour, seven_day,
 * limits, provider) mirror the primary stream so older servers/readers keep
 * working; `streams` carries every available stream this cycle.
 */
export const bodySchema = z.object({
  user_id: z.string().uuid().optional(),
  five_hour: windowSchema.optional(),
  seven_day: windowSchema.optional(),
  limits: z.array(limitSchema).max(40).nullable().optional(),
  provider: providerSchema.optional(),
  streams: z.array(streamSchema).max(6).optional(),
  // Self-reported cadence (sharer v6.2+). Wider band than the sharer's clamp,
  // with slack for future changes (see ingest route comment).
  push_seconds: z.number().int().min(60).max(7200).optional(),
  sharer_version: z.string().max(16).optional(),
});

// ─── Types derived from the schema (single source for routes + frontend) ───

export type UsageWindow = z.infer<typeof windowSchema>;
export type UsageLimit = z.infer<typeof limitSchema>;
export type UsageProvider = z.infer<typeof providerSchema>;
export type UsageStream = z.infer<typeof streamSchema>;
export type SnapshotBody = z.infer<typeof bodySchema>;
