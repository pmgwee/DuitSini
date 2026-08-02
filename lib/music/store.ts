import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { HistoryEntry } from "./types";

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
