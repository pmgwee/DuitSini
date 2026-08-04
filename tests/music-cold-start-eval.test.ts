import { describe, expect, it } from "vitest";
import { sequence, type TagVector } from "@/lib/music/similarity";
import type { Candidate } from "@/lib/music/types";
import type { MusicTrack } from "@/types/music";

/**
 * Offline, deterministic eval for the cold-start tag prior in `similarity.ts`.
 * No network, no GLM, no DB — it proves the MECHANISM: a cold track (one that
 * shares no co-occurrence source with anything, exactly where the behavioural
 * system is blind) gets pulled next to a tag-similar neighbour when tag vectors
 * are supplied, and stays buried under pure co-occurrence when they are not.
 *
 * A full live eval (next-played rank / cold-item coverage on real history) is
 * the follow-up once we have logged data; this is the regression test that the
 * prior is wired and has the intended effect.
 */

function track(id: string): MusicTrack {
  return { videoId: id, title: id, channel: `Artist ${id}`, thumbnail: null, source: "recommended" };
}
function cand(id: string, occurrences: Candidate["occurrences"]): Candidate {
  return { track: track(id), occurrences };
}
function occ(sourceId: string, rank: number) {
  return { sourceId, origin: "radio" as const, rank, seedWeight: 1 };
}
function tags(...t: string[]): TagVector {
  const v: TagVector = new Map();
  for (const x of t) v.set(x, 1);
  return v;
}

// Warm cluster: T1–T4 share sources so they have co-occurrence similarity.
// C1, C2 are COLD — no occurrences, so co-occurrence cosine is 0 with everything.
const pool: Candidate[] = [
  cand("T1", [occ("s1", 0), occ("s2", 0)]),
  cand("T2", [occ("s1", 1)]),
  cand("T3", [occ("s1", 2)]),
  cand("T4", [occ("s2", 1)]),
  cand("C1", []), // cold
  cand("C2", []), // cold
];

const tagVectors = new Map<string, TagVector>([
  ["T1", tags("rock", "1990s")],
  ["T2", tags("rock")],
  ["T3", tags("rock")],
  ["T4", tags("rock")],
  ["C1", tags("rock", "1990s")], // tag-identical to T1 → should sit beside it
  ["C2", tags("jazz", "ambient")], // no tag overlap → stays cold
]);

const indexOf = (order: Candidate[], id: string) => order.findIndex((c) => c.track.videoId === id);

describe("cold-start tag prior (similarity.sequence)", () => {
  it("baseline buries the cold track (pure co-occurrence)", () => {
    const order = sequence(pool, 0); // no tagVectors
    // C1 shares no source with anything → 0 similarity → greedy parks it late.
    expect(indexOf(order, "C1")).toBeGreaterThanOrEqual(4);
  });

  it("the prior pulls a tag-similar cold track up next to its neighbour", () => {
    const order = sequence(pool, 0, { tagVectors });
    // C1 is tag-identical to the opener T1 → pairSim(T1,C1) = 1.0 (evidence 0 →
    // full prior), which beats the warm co-occurrence score (~0.71). So C1
    // lands immediately after T1.
    expect(indexOf(order, "C1")).toBe(1);
  });

  it("a cold track with NO tag overlap is not pulled up", () => {
    const order = sequence(pool, 0, { tagVectors });
    // C2 (jazz) shares neither sources nor tags → stays at the back.
    expect(indexOf(order, "C2")).toBeGreaterThanOrEqual(4);
  });

  it("with no tag vectors supplied, behaviour is unchanged (backwards-compatible)", () => {
    const a = sequence(pool, 0);
    const b = sequence(pool, 0, { tagVectors: undefined });
    expect(b.map((c) => c.track.videoId)).toEqual(a.map((c) => c.track.videoId));
  });
});
