import "server-only";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import type { TagStore } from "./tags";

/**
 * Database-backed `TagStore` over the catalog-global `music_track_tags` table.
 *
 * Uses the SERVICE-ROLE admin client because the cache is server-managed and
 * catalog-global (a track's tags are the same for everyone) — there is no
 * user-scoped owner, so cookie-client RLS is the wrong fit. Returns `null`
 * when the service role isn't configured (dev/mock), in which case
 * `ensureTagVectors` simply recomputes on the fly and skips persistence.
 */
export function createDbTagStore(): TagStore | null {
  if (!isAdminConfigured()) return null;
  const supabase = createSupabaseAdminClient();

  return {
    async get(videoIds: string[]): Promise<Map<string, string[]>> {
      const out = new Map<string, string[]>();
      if (videoIds.length === 0) return out;
      const { data, error } = await supabase
        .from("music_track_tags")
        .select("video_id, tags")
        .in("video_id", videoIds);
      if (error || !data) return out; // cache miss / error → recompute
      for (const row of data) {
        if (row && Array.isArray(row.tags)) out.set(row.video_id, row.tags as string[]);
      }
      return out;
    },

    async put(entries: Array<{ videoId: string; tags: string[] }>): Promise<void> {
      if (entries.length === 0) return;
      const rows = entries.map((e) => ({ video_id: e.videoId, tags: e.tags }));
      await supabase.from("music_track_tags").upsert(rows, { onConflict: "video_id" });
    },
  };
}
