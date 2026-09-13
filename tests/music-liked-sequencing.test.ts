import { describe, expect, it } from "vitest";
import { sequence } from "@/lib/music/similarity";
import type { Candidate, Occurrence } from "@/lib/music/types";

/**
 * Liked tracks must not arrive as one consecutive block.
 *
 * `buildShelf` injects the listener's likes as candidates so the reserved
 * `loved` pool always has material. The first version gave every one of them
 * the SAME source id ("liked-library"), and `similarity.ts` builds its
 * co-occurrence vector from source ids — so all liked tracks became identical
 * vectors, cosine 1.0 to each other, and the greedy sequencer chained them
 * head-to-tail. The shelf showed four hearted songs in a row every time.
 *
 * The fix is a per-track source id, which leaves each liked track positioned by
 * its real neighbourhood (the radios it also appears in) rather than by an
 * artefact of how it was injected.
 */

function occurrence(sourceId: string, rank = 0): Occurrence {
  return { sourceId, origin: "radio", rank, seedWeight: 1 };
}

function candidate(videoId: string, channel: string, occurrences: Occurrence[]): Candidate {
  return {
    track: { videoId, title: videoId, channel, thumbnail: null, source: "recommended" },
    occurrences,
  };
}

/** Longest run of consecutive liked tracks in the sequenced order. */
function longestLikedRun(order: Candidate[], liked: Set<string>): number {
  let best = 0;
  let run = 0;
  for (const item of order) {
    run = liked.has(item.track.videoId) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Six liked tracks plus twelve discoveries, each in its own neighbourhood. */
function buildPool(likedSourceId: (videoId: string) => string) {
  const liked = new Set<string>();
  const pool: Candidate[] = [];
  for (let i = 0; i < 6; i++) {
    const id = `liked-${i}`;
    liked.add(id);
    pool.push(
      // Each liked track also genuinely appears in a different radio, which is
      // what should decide where it sits.
      candidate(id, `Artist ${i}`, [occurrence(likedSourceId(id)), occurrence(`radio-${i}`, 3)]),
    );
  }
  for (let i = 0; i < 12; i++) {
    pool.push(candidate(`new-${i}`, `Artist ${i % 6}`, [occurrence(`radio-${i % 6}`, i)]));
  }
  return { pool, liked };
}

describe("liked tracks in the sequenced shelf", () => {
  it("does not chain every liked track together", () => {
    const { pool, liked } = buildPool((id) => `liked:lib:${id}`);
    const order = sequence(pool, 0, {});
    expect(order).toHaveLength(pool.length);
    // Two adjacent is ordinary; six in a row is the artefact.
    expect(longestLikedRun(order, liked)).toBeLessThan(4);
  });

  it("demonstrates the defect when the injected source id is shared", () => {
    // Pins the CAUSE, so a future refactor that reintroduces a shared bucket
    // fails here with an explanation rather than only looking odd in the UI.
    const { pool, liked } = buildPool(() => "liked-library");
    const order = sequence(pool, 0, {});
    expect(longestLikedRun(order, liked)).toBeGreaterThanOrEqual(4);
  });

  it("keeps every track exactly once whichever way they are grouped", () => {
    const { pool } = buildPool((id) => `liked:lib:${id}`);
    const order = sequence(pool, 0, {});
    expect(new Set(order.map((c) => c.track.videoId)).size).toBe(pool.length);
  });
});
