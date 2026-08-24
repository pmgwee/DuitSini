import "server-only";
import { z } from "zod";
import { generateStructuredWithLLM, isLlmConfigured } from "@/lib/ai/llm";

/**
 * LLM-derived, CONSTRAINED-VOCABULARY tag layer over the catalog — the shared
 * foundation for the two LLM roles this recommender adopts:
 *   1. a cold-start similarity prior (`similarity.ts`), and
 *   2. an intent parser for the vibe surface (`vibe.ts`).
 *
 * WHY CONSTRAINED. AgenticTagger (arxiv 2602.05945) showed that letting an LLM
 * emit free-form tags causes "vocabulary explosion" — more unique features than
 * items — which destroys downstream modelling. The fix is to force the LLM to
 * choose from a fixed, low-cardinality vocabulary. We do exactly that: a small
 * curated set of genres, moods and eras the LLM must pick from. This is the
 * pragmatic analogue of Spotify's learned Semantic IDs (we don't fine-tune, so
 * we constrain at prompt time instead).
 *
 * WHY ANONYMOUS. Only track metadata (title/artist/videoId) is sent to the LLM — no
 * user identity, no listening history. videoId is a public YouTube identifier,
 * not PII. The path stays effectively anonymous even though a server key now
 * exists.
 *
 * Caching is handled by the caller via `TagStore` (the `music_track_tags` table)
 * — tags are computed once per track and reused forever, so cost is amortised
 * and never sits on the per-request hot path.
 */

// ── Fixed vocabulary (the LLM must pick from this set only) ─────────────────
export const GENRES = [
  "pop", "rock", "indie", "folk", "hip-hop", "r&b", "soul", "funk",
  "electronic", "edm", "dance", "house", "techno", "trance", "drum-and-bass",
  "ambient", "lo-fi", "metal", "punk", "country", "latin", "k-pop", "j-pop",
  "jazz", "blues", "classical", "reggae", "singer-songwriter",
] as const;
export const MOODS = [
  "chill", "upbeat", "energetic", "melancholic", "romantic", "focus",
  "party", "calm", "dark", "happy", "nostalgic", "aggressive", "dreamy",
  "cinematic", "epic",
] as const;
export const ERAS = [
  "1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s",
] as const;

const VOCAB = new Set<string>([...GENRES, ...MOODS, ...ERAS]);

/** A sparse tag vector — same shape as the co-occurrence vectors in similarity.ts. */
export type TagVector = Map<string, number>;

/** Pluggable cache so this module stays testable without a database. */
export interface TagStore {
  /** Return only the tags already cached for the given ids. */
  get(videoIds: string[]): Promise<Map<string, string[]>>;
  /** Persist freshly computed tags. */
  put(entries: Array<{ videoId: string; tags: string[] }>): Promise<void>;
}

export interface TrackInput {
  videoId: string;
  title: string;
  channel: string;
}

/** Convert a list of tag strings into a sparse vector (binary membership). */
export function tagVectorOf(tags: string[]): TagVector {
  const v: TagVector = new Map();
  for (const tag of tags) {
    if (VOCAB.has(tag)) v.set(tag, 1);
  }
  return v;
}

/** Drop anything the LLM emitted outside the vocabulary (the constrain step). */
function validate(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of raw) {
    const norm = String(tag).trim().toLowerCase();
    if (VOCAB.has(norm) && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

const BATCH_SIZE = 16;

/**
 * The wire contract for a tagging batch. An ARRAY of {id, tags} rather than a
 * dynamically-keyed object, because that shape is expressible as a JSON schema
 * and can therefore be enforced by the provider's structured-output mode. The
 * vocabulary constraint is still applied locally by `validate()`, so an
 * out-of-vocabulary tag is dropped rather than failing the batch.
 */
const tagBatchSchema = z.object({
  tracks: z
    .array(
      z.object({
        id: z.string(),
        tags: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

/**
 * Tag a batch of tracks (≤ BATCH_SIZE) in one LLM call. Returns videoId → tags.
 * Never throws for individual tracks: on any failure the map is just shorter.
 */
async function tagBatch(batch: TrackInput[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!isLlmConfigured() || batch.length === 0) return out;

  const lines = batch.map((t, i) => `${i + 1}. ${t.title} — ${t.channel} (id:${t.videoId})`).join("\n");
  const system =
    "You are a music metadata tagger. For each track, choose 1–4 tags that best " +
    "describe it, using ONLY tags from the fixed vocabulary below. Do not invent " +
    "tags. Respond as a JSON object with a \"tracks\" array.\n\n" +
    `Genres: ${GENRES.join(", ")}\n` +
    `Moods: ${MOODS.join(", ")}\n` +
    `Eras: ${ERAS.join(", ")}`;
  const user =
    'Return JSON like {"tracks":[{"id":"<id>","tags":["tag", ...]}, ...]} with one ' +
    "entry per track. Use the id exactly as given after the id: prefix.\n\n" + lines;

  let parsed: z.infer<typeof tagBatchSchema>;
  try {
    parsed = await generateStructuredWithLLM({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      schema: tagBatchSchema,
      schemaName: "track_tags",
      schemaDescription: "Constrained-vocabulary tags for a batch of tracks.",
      temperature: 0,
      reasoning: "none",
      maxTokens: 800,
    });
  } catch {
    // network / model / malformed-output error → degrade silently, no tags for
    // this batch (callers treat a missing vector as "behavioural signal only").
    return out;
  }

  const byId = new Map(parsed.tracks.map((t) => [String(t.id).trim(), t.tags]));
  for (const track of batch) {
    const raw = byId.get(track.videoId);
    if (Array.isArray(raw)) {
      const tags = validate(raw.filter((x): x is string => typeof x === "string"));
      if (tags.length > 0) out.set(track.videoId, tags);
    }
  }
  return out;
}

/**
 * Ensure every track has a tag vector: serve from the cache, compute the rest
 * via the LLM (batched), and persist the new ones. Tracks the model can't tag are
 * simply absent from the result — callers must treat a missing vector as
 * "use behavioural signal only", which `similarity.ts` already does.
 */
export async function ensureTagVectors(
  tracks: TrackInput[],
  store: TagStore | null,
): Promise<Map<string, TagVector>> {
  const out = new Map<string, TagVector>();
  if (tracks.length === 0) return out;

  const byId = new Map(tracks.map((t) => [t.videoId, t]));
  const wanted = [...byId.keys()];

  // 1. Serve from cache.
  let cachedIds = new Set<string>();
  if (store) {
    try {
      const cached = await store.get(wanted);
      for (const [id, tags] of cached) {
        out.set(id, tagVectorOf(tags));
        cachedIds.add(id);
      }
    } catch {
      cachedIds = new Set(); // cache read failed → recompute all
    }
  }

  // 2. Compute the rest in batches, persist as we go.
  const missing = tracks.filter((t) => !cachedIds.has(t.videoId));
  const newlyComputed: Array<{ videoId: string; tags: string[] }> = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    const result = await tagBatch(batch);
    for (const [id, tags] of result) {
      out.set(id, tagVectorOf(tags));
      newlyComputed.push({ videoId: id, tags });
    }
  }
  if (store && newlyComputed.length > 0) {
    try {
      await store.put(newlyComputed);
    } catch {
      // persist failure is non-fatal: we still return the in-memory vectors
    }
  }

  return out;
}
