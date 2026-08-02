import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Behavioural signal ingest — skips and completions.
 *
 * This is the data the ranker was missing entirely. A play alone says nothing
 * about whether the listener wanted the track; an early skip says a great deal.
 * Both Spotify (BaRT's reward term) and Apple Music weight a <30s abandon as
 * their strongest negative, and it's the input the learned transition model
 * needs in order to converge.
 *
 * `from` records which track handed off to this one, so we learn not just
 * "B was skipped" but "B was skipped when it followed A" — the local-sequential
 * effect that Spotify detects with audio features we can't obtain.
 */

const signalSchema = z.object({
  videoId: z.string().min(1).max(64),
  signal: z.enum(["skip", "complete"]),
  /** The track that played immediately before, if this was an auto-advance. */
  from: z.string().max(64).nullable().default(null),
});

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = signalSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const { videoId, signal, from } = body.data;

  // Track-level signal. Best-effort: a missing music_plays row (signal arriving
  // before the play was logged) simply updates nothing.
  const { error } = await supabase.rpc("log_music_signal", {
    p_video_id: videoId,
    p_signal: signal,
  });
  if (error) console.error("[yt/signals] track signal failed:", error.message);

  // Transition-level signal — only meaningful for an automatic hand-off.
  if (from && from !== videoId) {
    const { error: transitionError } = await supabase.rpc("log_music_transition", {
      p_from_video_id: from,
      p_to_video_id: videoId,
      p_signal: signal,
    });
    if (transitionError) {
      console.error("[yt/signals] transition failed:", transitionError.message);
    }
  }

  return NextResponse.json({ ok: true });
}
