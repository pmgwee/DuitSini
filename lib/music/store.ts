import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { HistoryEntry, LikedTrack, Suppressions } from "./types";

/**
 * Reads of the listener's behavioural record. All RLS-scoped — these run on the
 * cookie-bound server client, so a user only ever sees their own rows.
 */

type Client = SupabaseClient<Database>;

/** How much history feeds seed selection. Deeper than the old 24-row shelf. */
const HISTORY_LIMIT = 60;

/**
 * The listener's play history, most-recent first, with the signals the ranker
 * needs. Returns `[]` on any error — the caller degrades rather than 500s.
 */
export async function loadHistory(supabase: Client, userId: string): Promise<HistoryEntry[]> {
  const { data, error } = await supabase
    .from("music_plays")
    .select("video_id, title, channel, thumbnail, play_count, last_played_at, skip_count, complete_count")
    .eq("user_id", userId)
    .order("last_played_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (error || !data) {
    if (error) console.error("[music/store] history load failed:", error.message);
    return [];
  }

  return data.map((row) => ({
    videoId: row.video_id,
    title: row.title,
    channel: row.channel,
    thumbnail: row.thumbnail,
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at,
    skipCount: row.skip_count ?? 0,
    completeCount: row.complete_count ?? 0,
  }));
}

/**
 * Every videoId this listener has ever played — ids only, no window.
 *
 * `loadHistory` caps at 60 rows because it carries full metadata for seeding.
 * That cap silently became the recommender's entire memory: a track played 200
 * times last year fell outside it and was then indistinguishable from a song
 * the listener had never heard, so the shelf kept "discovering" its own back
 * catalogue. Ids are cheap — a few thousand rows is tens of kilobytes — so the
 * durable answer to "have they heard this?" is always available.
 */
export async function loadEverPlayed(supabase: Client, userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; from < 20_000; from += PAGE) {
    const { data, error } = await supabase
      .from("music_plays")
      .select("video_id")
      .eq("user_id", userId)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[music/store] ever-played load failed:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    for (const row of data) ids.add(row.video_id);
    if (data.length < PAGE) break;
  }
  return ids;
}

/** Every track the listener has liked, newest first. `[]` on any error. */
export async function loadLikes(supabase: Client, userId: string): Promise<LikedTrack[]> {
  const { data, error } = await supabase
    .from("music_likes")
    .select("video_id, title, channel, thumbnail, liked_at")
    .eq("user_id", userId)
    .order("liked_at", { ascending: false })
    .limit(500);

  if (error || !data) {
    if (error) console.error("[music/store] likes load failed:", error.message);
    return [];
  }

  return data.map((row) => ({
    videoId: row.video_id,
    title: row.title,
    channel: row.channel,
    thumbnail: row.thumbnail,
    likedAt: row.liked_at,
  }));
}

/**
 * Tracks the listener has pushed away.
 *
 * An expired snooze is simply not returned — the row can stay until it is
 * overwritten, so lapsing needs no cleanup job.
 */
export async function loadSuppressions(
  supabase: Client,
  userId: string,
): Promise<Suppressions> {
  const suppressions: Suppressions = { notInterested: new Set(), snoozedUntil: new Map() };

  const { data, error } = await supabase
    .from("music_suppressions")
    .select("video_id, kind, until")
    .eq("user_id", userId)
    .limit(2000);

  if (error || !data) {
    if (error) console.error("[music/store] suppressions load failed:", error.message);
    return suppressions;
  }

  const now = Date.now();
  for (const row of data) {
    if (row.kind === "not_interested") {
      suppressions.notInterested.add(row.video_id);
      continue;
    }
    if (row.until && Date.parse(row.until) > now) {
      suppressions.snoozedUntil.set(row.video_id, row.until);
    }
  }
  return suppressions;
}

/**
 * The learned local-sequential model, as a bias map keyed `${from}>${to}`.
 *
 * This is what closes the gap left by Spotify's removed audio-feature API. We
 * can't measure whether two tracks sound alike, but we can measure whether THIS
 * listener stayed with B when it followed A — which is the effect the acoustic
 * model was a proxy for in the first place. Values are bounded to ±0.5 so a
 * couple of early data points can nudge, but never dictate, the ordering.
 */
export async function loadTransitionBias(
  supabase: Client,
  userId: string,
): Promise<Map<string, number>> {
  const bias = new Map<string, number>();

  const { data, error } = await supabase
    .from("music_transitions")
    .select("from_video_id, to_video_id, skips, completions")
    .eq("user_id", userId)
    .limit(2000);

  if (error || !data) {
    if (error) console.error("[music/store] transition load failed:", error.message);
    return bias;
  }

  for (const row of data) {
    const total = row.skips + row.completions;
    if (total === 0) continue;
    // Laplace-smoothed completion rate, recentred on 0 and damped by evidence:
    // one observation moves the needle a little, ten move it a lot.
    const rate = (row.completions + 1) / (total + 2);
    const confidence = Math.min(1, total / 10);
    bias.set(`${row.from_video_id}>${row.to_video_id}`, (rate - 0.5) * confidence);
  }

  return bias;
}
