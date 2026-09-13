import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureTagVectors, untaggedTracks } from "@/lib/music/tags";
import { createDbTagStore } from "@/lib/music/tags-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Deliberately longer than the shelf route: this one is allowed to be slow
// because nothing is waiting on it.
export const maxDuration = 60;

/**
 * Warm the constrained-vocabulary tag cache, off the critical path.
 *
 * Tagging is a reasoning-model call — measured 2026-09-14, ~16s per batch at
 * `xhigh` effort. It used to run inside the shelf build, where three sequential
 * batches (~48s) against a 30-second route budget timed out every build whose
 * slate contained uncached tracks. Since a discovery shelf is mostly uncached
 * by construction, that was every build: the route returned non-OK and the
 * client fell back to an empty shelf.
 *
 * Tags are only a sequencing prior (`similarity.ts` treats a missing vector as
 * "use co-occurrence alone"), so the shelf now reads the cache and never waits.
 * This endpoint fills that cache afterwards, from the client, once the listener
 * already has their music. A failure here costs a slightly less smooth running
 * order on a later build and nothing else.
 *
 * Only videoIds are accepted, and only public track metadata is sent onward —
 * no listener identity, no history. The work is capped per call so one request
 * cannot run away.
 */

const bodySchema = z.object({
  tracks: z
    .array(
      z.object({
        videoId: z.string().min(1).max(64),
        title: z.string().min(1).max(300),
        channel: z.string().max(200).default(""),
      }),
    )
    .min(1)
    .max(60),
});

/** Batches computed per request. One batch is 16 tracks and ~16s. */
const MAX_BATCHES = 2;

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const store = createDbTagStore();
  try {
    // Skip what is already cached before spending a single call.
    const missing = await untaggedTracks(body.data.tracks, store);
    if (missing.length === 0) return NextResponse.json({ ok: true, tagged: 0, remaining: 0 });

    const vectors = await ensureTagVectors(missing, store, { maxBatches: MAX_BATCHES, timeoutMs: 25_000 });
    return NextResponse.json({
      ok: true,
      tagged: vectors.size,
      // The client can call again to continue; each call makes progress.
      remaining: Math.max(0, missing.length - MAX_BATCHES * 16),
    });
  } catch (err) {
    console.warn("[yt/tags] warm failed:", (err as Error)?.message ?? err);
    // Never surfaced to the listener — the shelf is already on screen.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
