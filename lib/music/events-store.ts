import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";
import {
  buildExposure,
  type ExposureRecord,
  type ImpressionEvent,
  type ListenEvent,
  type PlayOrigin,
  type PlayOutcome,
} from "./exposure";
import type { VocalLanguage } from "./language";

/**
 * Reads and writes for the exposure tables added in migration 0021.
 *
 * All RLS-scoped: these run on the cookie-bound server client, so a listener
 * only ever touches their own rows. `music_track_language` is the exception and
 * is deliberately shared — a track's vocal language is a property of the track,
 * carries no personal data, and would otherwise be recomputed per user.
 *
 * Migration 0021 is applied and `lib/supabase/types.ts` regenerated, so these
 * go through the ordinary typed client with no casts.
 */

type Client = SupabaseClient<Database>;

/** Longest window the recommender reads. Anything older cannot change a score. */
const WINDOW_DAYS = 90;
const MAX_EVENTS = 4000;
const MAX_IMPRESSIONS = 8000;

function sinceIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function asOrigin(value: string): PlayOrigin {
  return value === "manual" || value === "search" || value === "playlist" || value === "radio"
    ? value
    : "autoplay";
}

function asOutcome(value: string): PlayOutcome {
  return value === "completed" ||
    value === "substantial" ||
    value === "late_skip" ||
    value === "early_skip"
    ? value
    : "unknown";
}

/**
 * Load the exposure window and fold it into per-track records.
 *
 * Returns an empty map on any error so the recommender degrades to the legacy
 * aggregate projection rather than failing the request — a shelf built from
 * thinner memory is much better than no shelf.
 */
export async function loadExposure(
  supabase: Client,
  userId: string,
  everPlayed: ReadonlySet<string>,
  now: number = Date.now(),
): Promise<Map<string, ExposureRecord>> {
  const client = supabase;
  const since = sinceIso(WINDOW_DAYS);

  const [events, impressions] = await Promise.all([
    client
      .from("music_play_events")
      .select("video_id, occurred_at, origin, outcome, duration_ratio")
      .eq("user_id", userId)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(MAX_EVENTS)
      ,
    client
      .from("music_impressions")
      .select("video_id, shown_at, position")
      .eq("user_id", userId)
      .gte("shown_at", since)
      .order("shown_at", { ascending: false })
      .limit(MAX_IMPRESSIONS)
      ,
  ]);

  if (events.error || impressions.error) {
    // Expected until migration 0021 is applied; not an error worth alarming on.
    console.warn(
      "[music/events] exposure unavailable, falling back to aggregates:",
      events.error?.message ?? impressions.error?.message,
    );
    return buildExposure({ listens: [], impressions: [] }, now, everPlayed);
  }

  const listens: ListenEvent[] = (events.data ?? []).map((row) => ({
    videoId: row.video_id,
    at: Date.parse(row.occurred_at),
    origin: asOrigin(row.origin),
    outcome: asOutcome(row.outcome),
    durationRatio: row.duration_ratio,
  }));
  const shown: ImpressionEvent[] = (impressions.data ?? []).map((row) => ({
    videoId: row.video_id,
    at: Date.parse(row.shown_at),
    position: row.position,
  }));

  return buildExposure({ listens, impressions: shown }, now, everPlayed);
}

/** Recent playback events, for learning the language mix. */
export async function loadListenEvents(
  supabase: Client,
  userId: string,
): Promise<ListenEvent[]> {
  const { data, error } = await supabase
    .from("music_play_events")
    .select("video_id, occurred_at, origin, outcome, duration_ratio")
    .eq("user_id", userId)
    .gte("occurred_at", sinceIso(WINDOW_DAYS))
    .order("occurred_at", { ascending: false })
    .limit(MAX_EVENTS)
    ;
  if (error || !data) return [];
  return data.map((row) => ({
    videoId: row.video_id,
    at: Date.parse(row.occurred_at),
    origin: asOrigin(row.origin),
    outcome: asOutcome(row.outcome),
    durationRatio: row.duration_ratio,
  }));
}

export interface PlayEventInput {
  videoId: string;
  origin: PlayOrigin;
  outcome: PlayOutcome;
  durationRatio: number;
  surface?: string;
  sessionId?: string | null;
}

/** Append one playback event. Fire-and-forget; never throws. */
export async function recordPlayEvent(
  supabase: Client,
  userId: string,
  input: PlayEventInput,
): Promise<boolean> {
  const { error } = await supabase.from("music_play_events").insert({
    user_id: userId,
    video_id: input.videoId,
    origin: input.origin,
    outcome: input.outcome,
    duration_ratio: Math.max(0, Math.min(1, input.durationRatio)),
    surface: input.surface ?? "listen-again",
    session_id: input.sessionId ?? null,
  });
  if (error) {
    console.warn("[music/events] play event not recorded:", error.message);
    return false;
  }
  return true;
}

export interface ImpressionInput {
  videoId: string;
  position: number;
  pool: string;
  source: string;
  retrievalRank: number;
  language: VocalLanguage;
  score: number;
}

/**
 * Record every slot of one shelf build.
 *
 * Written as a single batch insert: a partial impression record is worse than
 * none, because it understates exposure and therefore under-suppresses exactly
 * the tracks that were shown most.
 */
export async function recordImpressions(
  supabase: Client,
  userId: string,
  buildId: string,
  slots: readonly ImpressionInput[],
  modelVersion = "pools-v1",
): Promise<boolean> {
  if (slots.length === 0) return true;
  const { error } = await supabase.from("music_impressions").insert(
    slots.map((slot) => ({
      user_id: userId,
      build_id: buildId,
      video_id: slot.videoId,
      position: slot.position,
      pool: slot.pool,
      source: slot.source,
      retrieval_rank: slot.retrievalRank,
      language: slot.language,
      score: slot.score,
      model_version: modelVersion,
    })),
  );
  if (error) {
    console.warn("[music/events] impressions not recorded:", error.message);
    return false;
  }
  return true;
}

/** Cached language labels for a set of tracks. `{}` on any error. */
export async function loadTrackLanguages(
  supabase: Client,
  videoIds: readonly string[],
): Promise<Map<string, { language: VocalLanguage; confidence: number }>> {
  const labels = new Map<string, { language: VocalLanguage; confidence: number }>();
  if (videoIds.length === 0) return labels;
  const { data, error } = await supabase
    .from("music_track_language")
    .select("video_id, language, confidence")
    .in("video_id", [...videoIds].slice(0, 1000))
    ;
  if (error || !data) return labels;
  for (const row of data) {
    labels.set(row.video_id, {
      language: row.language as VocalLanguage,
      confidence: row.confidence,
    });
  }
  return labels;
}

/**
 * Persist inferred labels so a corroborated one survives, and so the language
 * funnel (availability -> exposed -> accepted) is answerable in SQL.
 *
 * Only writes labels that clear the serving threshold: storing `unknown` would
 * pin a track at "we could not tell" even after better evidence arrives, and an
 * absent row already means exactly that.
 */
export async function saveTrackLanguages(
  supabase: Client,
  labels: ReadonlyMap<string, { language: VocalLanguage; confidence: number; evidence?: unknown }>,
): Promise<void> {
  const rows = [...labels]
    .filter(([, label]) => label.language !== "unknown")
    .slice(0, 500)
    .map(([videoId, label]) => ({
      video_id: videoId,
      language: label.language,
      confidence: label.confidence,
      evidence: JSON.parse(JSON.stringify(label.evidence ?? [])) as Json,
      updated_at: new Date().toISOString(),
    }));
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("music_track_language")
    .upsert(rows, { onConflict: "video_id" });
  if (error) console.warn("[music/events] language labels not saved:", error.message);
}
