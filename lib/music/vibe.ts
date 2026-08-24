import "server-only";
import { z } from "zod";
import { generateStructuredWithLLM, isLlmConfigured } from "@/lib/ai/llm";
import { GENRES, MOODS, ERAS } from "./tags";

/**
 * The intent parser for the vibe surface — the role every major DSP ships in
 * 2026 (Spotify AI Playlist, YouTube Music "Ask Music", Apple Playlist
 * Playground, Deezer Text2Playlist): an LLM maps a free-text request onto the
 * SAME dimensions the recommender already understands, then the existing
 * behavioural pipeline fulfils it. The LLM never picks songs here; it captures
 * intent and the ranker does the rest.
 *
 * Grounding discipline (the lesson from Spotify DJ's public failures + GLIDE):
 * genres/moods/eras are constrained to the fixed vocabulary from `tags.ts`, and
 * seed names are resolved to real videoIds by the caller via YouTube search —
 * the model is never allowed to emit a free-form title or a hallucinated id.
 *
 * The LLM separates two kinds of named intent: an ARTIST ("top songs by X" →
 * `artists`, resolved to a channel id and fulfilled from the artist's own
 * popularity-ordered Songs shelf) and a SONG / "artist - song" (`seedNames`,
 * resolved to a videoId and fulfilled via song-radio). The distinction is what
 * lets "top songs by the chainsmokers" return the Chainsmokers' catalog instead
 * of a similar-track radio.
 */

export interface VibeConstraints {
  /** Fixed-vocabulary tags the user asked for. */
  genres: string[];
  moods: string[];
  eras: string[];
  /** Up to 3 artist names whose catalog / top songs the user wants to hear. */
  artists?: string[];
  /** Up to 3 song or "artist - song" strings to resolve via search. */
  seedNames: string[];
  /** Lowercased words to avoid in result titles. */
  exclude: string[];
  /** Target track count. */
  length: number;
}

/**
 * The wire contract the model is held to. Deliberately permissive (plain string
 * arrays) — the vocabulary constraint is enforced locally by `fromVocab` below,
 * so a model that drifts outside the vocabulary loses the stray tag rather than
 * failing the whole parse. Same shape the previous provider was prompted for.
 */
const vibeSchema = z.object({
  genres: z.array(z.string()).default([]),
  moods: z.array(z.string()).default([]),
  eras: z.array(z.string()).default([]),
  artists: z.array(z.string()).default([]),
  seedNames: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  length: z.number().default(25),
});

function fromVocab(value: unknown, allowed: readonly string[]): string[] {
  if (!Array.isArray(value)) return [];
  const set = new Set(allowed);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const norm = item.trim().toLowerCase();
    if (set.has(norm) && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function fromStrings(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (clean) out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Parse a free-text music request into structured constraints. Returns `null`
 * when the LLM is unavailable or the response is unparseable — callers then
 * answer with an empty result rather than guessing.
 */
export async function parseVibe(prompt: string): Promise<VibeConstraints | null> {
  const trimmed = prompt.trim();
  if (!trimmed || !isLlmConfigured()) return null;

  const system =
    "You map a music request onto structured dimensions for a recommender. " +
    "Choose genres/moods/eras ONLY from these fixed vocabularies (lowercase):\n" +
    `genres: ${GENRES.join(", ")}\n` +
    `moods: ${MOODS.join(", ")}\n` +
    `eras: ${ERAS.join(", ")}\n\n` +
    "Also extract two kinds of named intent. 'artists' (up to 3): a specific " +
    "ARTIST whose top songs / catalog the user wants — phrases like 'top songs " +
    "by X', 'best of X', 'songs by X'. 'seedNames' (up to 3): a specific SONG " +
    "or 'artist - song' the user wants to start from. Plus any exclude words " +
    "(a genre/artist/mood to avoid). Respond as a JSON object only.";
  const user =
    `Prompt: """${trimmed}"""\n\n` +
    'Return JSON: {"genres":[],"moods":[],"eras":[],"artists":[],"seedNames":[],"exclude":[],"length":N}. ' +
    "length defaults to 25 (5-50). artists = named artists whose catalog the user wants (may be empty); " +
    "seedNames = named songs or 'artist - song' to seed from (may be empty). Use only the vocabulary for tags.";

  let parsed: z.infer<typeof vibeSchema>;
  try {
    parsed = await generateStructuredWithLLM({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      schema: vibeSchema,
      schemaName: "vibe_constraints",
      schemaDescription: "Structured music-request constraints for the recommender.",
      temperature: 0,
      reasoning: "none",
      maxTokens: 500,
    });
  } catch {
    return null; // provider error or malformed/invalid output → degrade silently
  }

  const length = Number(parsed.length);
  return {
    genres: fromVocab(parsed.genres, GENRES),
    moods: fromVocab(parsed.moods, MOODS),
    eras: fromVocab(parsed.eras, ERAS),
    artists: fromStrings(parsed.artists, 3),
    seedNames: fromStrings(parsed.seedNames, 3),
    exclude: fromStrings(parsed.exclude, 8).map((s) => s.toLowerCase()),
    length: Number.isFinite(length) && length >= 5 && length <= 50 ? Math.floor(length) : 25,
  };
}

/**
 * When the user gave no specific seed names, synthesise a search query from the
 * requested tags so we still have something concrete to ground the radio in.
 */
export function synthSeedQuery(c: VibeConstraints): string {
  return [...c.genres, ...c.moods, ...c.eras].slice(0, 4).join(" ");
}
