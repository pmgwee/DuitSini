import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { recordPlayEvent } from "@/lib/music/events-store";

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
 *
 * The route now also appends an immutable playback EVENT alongside the
 * aggregate counters. The counters answer "how many times", which is the only
 * question the old schema could ask; the event stream answers "when, how, and
 * did they choose it" — the questions exposure and fatigue actually need. In
 * particular `outcome` distinguishes a natural completion, a substantial
 * listen, a late skip and an early skip, where the aggregate had a single
 * "skip" bucket for sub-30s abandons and recorded everything else as nothing.
 */

const signalSchema = z.object({
  videoId: z.string().min(1).max(64),
  signal: z.enum(["skip", "complete"]),
  /** The track that played immediately before, if this was an auto-advance. */
  from: z.string().max(64).nullable().default(null),
  /**
   * Richer event fields. All optional so an older client keeps working and
   * simply contributes a coarser event.
   */
  outcome: z
    .enum(["completed", "substantial", "late_skip", "early_skip", "unknown"])
    .optional(),
  origin: z.enum(["manual", "search", "playlist", "autoplay", "radio", "unknown"]).optional(),
  durationRatio: z.number().min(0).max(1).optional(),
  surface: z.string().max(40).optional(),
  sessionId: z.string().uuid().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = signalSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const { videoId, signal, from, outcome, origin, durationRatio, surface, sessionId } = body.data;

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

  // Immutable event, in parallel with the aggregates above. A failure here is
  // logged and swallowed: losing one event degrades the exposure model slightly
  // and must never cost the listener a playback interaction.
  await recordPlayEvent(supabase, user.id, {
    videoId,
    // An explicit outcome wins; otherwise fall back to the coarse signal so
    // pre-update clients still produce a usable (if blunt) event.
    outcome: outcome ?? (signal === "complete" ? "completed" : "early_skip"),
    origin: origin ?? "unknown",
    durationRatio: durationRatio ?? (signal === "complete" ? 1 : 0),
    surface: surface ?? "listen-again",
    sessionId: sessionId ?? null,
  });

  return NextResponse.json({ ok: true });
}
