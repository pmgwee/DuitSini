import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildRadio, continueRadio } from "@/lib/music/recommend";
import { loadHistory, loadTransitionBias } from "@/lib/music/store";
import type { MusicTrack } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Endless autoplay — the Apple Music "Autoplay (∞)" surface.
 *
 * When the player's queue runs dry it asks here for the next batch instead of
 * simply stopping, which is what used to strand the listener at the end of a
 * finite shelf. Two modes:
 *
 *   { seed }         start a fresh station from the track that just finished
 *   { continuation } extend the station already in flight (~49 more tracks)
 *
 * Anonymous throughout — no credential is involved anywhere in this path.
 */

const bodySchema = z
  .object({
    seed: z.string().regex(/^[\w-]{11}$/).optional(),
    continuation: z.string().min(1).max(4096).optional(),
    /** Ids already queued client-side, so we never hand back a duplicate. */
    exclude: z.array(z.string().max(64)).max(200).default([]),
    limit: z.number().int().min(1).max(50).default(25),
  })
  .refine((b) => Boolean(b.seed || b.continuation), {
    message: "seed or continuation required",
  });

export interface RadioResponse {
  tracks: MusicTrack[];
  /** Token to extend this station further; null when it can't be extended. */
  continuation: string | null;
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<RadioResponse>({ tracks: [], continuation: null }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json<RadioResponse>({ tracks: [], continuation: null }, { status: 400 });
  }
  const { seed, continuation, exclude, limit } = parsed.data;

  try {
    // Extending an in-flight station needs no personalisation work — the
    // station was already shaped when it started.
    if (continuation) {
      const page = await continueRadio(continuation, exclude);
      return NextResponse.json<RadioResponse>(page);
    }

    const [history, transitionBias] = await Promise.all([
      loadHistory(supabase, user.id),
      loadTransitionBias(supabase, user.id),
    ]);

    const station = await buildRadio(seed!, history, { limit, exclude, transitionBias });
    return NextResponse.json<RadioResponse>(station);
  } catch (err) {
    // Autoplay failing must be silent — the player just stops, as it did before.
    console.error("[yt/radio] failed:", (err as Error)?.message ?? err);
    return NextResponse.json<RadioResponse>({ tracks: [], continuation: null });
  }
}
