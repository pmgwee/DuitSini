import { describe, expect, it } from "vitest";
import { ensureTagVectors, untaggedTracks, type TagStore, type TrackInput } from "@/lib/music/tags";

/**
 * The tag layer must never block a listener's request.
 *
 * Tagging is a reasoning-model call — measured 2026-09-14, ~13-16s per batch at
 * `xhigh` effort. It used to run inside `buildShelf`, where a 40-track slate is
 * three sequential batches against a 30-second route budget. Every build whose
 * slate contained uncached tracks timed out, and since a discovery shelf is
 * uncached by construction, that was every build: the route returned non-OK and
 * the client fell back to rendering an empty shelf.
 *
 * These tests pin the property that prevents a recurrence. They use a store
 * that THROWS if the compute path is reached, so a regression fails loudly
 * instead of merely getting slow — the original failure was slow, not wrong,
 * which is exactly why it survived review.
 */

function track(videoId: string): TrackInput {
  return { videoId, title: `Title ${videoId}`, channel: `Artist ${videoId}` };
}

/** Records reads; `put` means the LLM ran, which is a failure on this path. */
function tripwireStore(cached: Record<string, string[]> = {}): TagStore & { puts: number } {
  return {
    puts: 0,
    async get(videoIds: string[]) {
      const out = new Map<string, string[]>();
      for (const id of videoIds) {
        const tags = cached[id];
        if (tags) out.set(id, tags);
      }
      return out;
    },
    async put() {
      this.puts += 1;
      throw new Error("compute path reached on a request-blocking call");
    },
  } as TagStore & { puts: number };
}

describe("tag vectors on a request-blocking path", () => {
  it("returns only cached vectors and never computes", async () => {
    const store = tripwireStore({ "a": ["indie", "chill"] });
    const started = Date.now();
    const vectors = await ensureTagVectors([track("a"), track("b"), track("c")], store, {
      cacheOnly: true,
    });

    expect(vectors.has("a")).toBe(true);
    // b and c are uncached: absent, not computed. `similarity.ts` treats a
    // missing vector as "use co-occurrence alone", so this degrades the running
    // order slightly and nothing else.
    expect(vectors.has("b")).toBe(false);
    expect(store.puts).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("computes nothing at all when the cache is empty", async () => {
    const store = tripwireStore();
    const vectors = await ensureTagVectors([track("x"), track("y")], store, { cacheOnly: true });
    expect(vectors.size).toBe(0);
    expect(store.puts).toBe(0);
  });

  it("survives a cache read failure without falling through to compute", async () => {
    // A cache outage must not silently turn into 48 seconds of LLM calls.
    const store: TagStore = {
      async get() {
        throw new Error("cache down");
      },
      async put() {
        throw new Error("compute path reached during a cache outage");
      },
    };
    await expect(
      ensureTagVectors([track("x")], store, { cacheOnly: true }),
    ).resolves.toEqual(new Map());
  });

  it("identifies what still needs tagging without spending a call", async () => {
    const store = tripwireStore({ "a": ["pop"] });
    const missing = await untaggedTracks([track("a"), track("b")], store);
    expect(missing.map((t) => t.videoId)).toEqual(["b"]);
    expect(store.puts).toBe(0);
  });

  it("treats everything as untagged when there is no store", async () => {
    const missing = await untaggedTracks([track("a")], null);
    expect(missing).toHaveLength(1);
  });
});
