import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Live smoke test for the LLM music backend: exercises the real GLM tagger, the
 * `music_track_tags` DB cache (service-role), and the vibe intent parser against
 * the live services. Skips gracefully if a key is absent. Cleans up its own rows.
 *
 * Run:  pnpm vitest run tests/music-llm-smoke.test.ts
 */

// Load `.env` into process.env (vitest doesn't auto-load it; no dotenv dep).
// split on CRLF or LF and trim — the file has mixed line endings on Windows.
for (const raw of readFileSync(`${process.cwd()}/.env`, "utf8").split(/\r?\n/)) {
  const m = raw.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) {
    process.env[m[1]] = m[2].replace(/^"|"$/g, "").trim();
  }
}

import { ensureTagVectors, GENRES, MOODS, ERAS } from "@/lib/music/tags";
import { createDbTagStore } from "@/lib/music/tags-store";
import { parseVibe, synthSeedQuery } from "@/lib/music/vibe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

// These tests hit the LIVE GLM API + the live `music_track_tags` table (and
// spend quota), so they're SKIPPED by default. Run on demand with:
//   RUN_LIVE_MUSIC_SMOKE=1 npx vitest run tests/music-llm-smoke.test.ts
const describeLive = process.env.RUN_LIVE_MUSIC_SMOKE === "1" ? describe : describe.skip;

const TEST_IDS = ["vibe_smoke_db", "vibe_smoke_1"];
const store = createDbTagStore();
const VOCAB = new Set<string>([...GENRES, ...MOODS, ...ERAS]);

afterAll(async () => {
  try {
    await createSupabaseAdminClient().from("music_track_tags").delete().in("video_id", TEST_IDS);
  } catch {
    // best-effort cleanup
  }
});

describeLive("DB tag store (service-role)", () => {
  it(
    "writes and reads back tags",
    async () => {
      if (!store) return; // admin not configured
      await store.put([{ videoId: "vibe_smoke_db", tags: ["rock", "1990s"] }]);
      const got = await store.get(["vibe_smoke_db"]);
      expect(got.get("vibe_smoke_db")?.slice().sort()).toEqual(["1990s", "rock"]);
    },
    20_000,
  );
});

describeLive("GLM tagger (live)", () => {
  it(
    "produces in-vocabulary tags for a well-known track",
    async () => {
      const vectors = await ensureTagVectors(
        [{ videoId: "vibe_smoke_1", title: "Wonderwall", channel: "Oasis" }],
        store,
      );
      const v = vectors.get("vibe_smoke_1");
      expect(v).toBeTruthy();
      const tags = v ? [...v.keys()] : [];
      expect(tags.length).toBeGreaterThan(0);
      for (const t of tags) expect(VOCAB.has(t)).toBe(true);
      // Wonderwall is British rock from the mid-90s — at least one of these
      // should land.
      expect(
        tags.some((t) => ["rock", "1990s", "2000s", "indie", "folk", "melancholic", "nostalgic"].includes(t)),
      ).toBe(true);
    },
    40_000,
  );
});

describeLive("parseVibe (live)", () => {
  it(
    "maps a prompt to constrained tags + exclude words",
    async () => {
      const c = await parseVibe("rainy-day indie folk, absolutely no EDM");
      expect(c).toBeTruthy();
      if (!c) return;
      expect(c.genres.concat(c.moods).some((t) => ["indie", "folk", "chill", "melancholic"].includes(t))).toBe(true);
      expect(c.exclude.map((x) => x.toLowerCase())).toContain("edm");
      expect(c.length).toBeGreaterThanOrEqual(5);
      expect(c.length).toBeLessThanOrEqual(50);
    },
    40_000,
  );

  it("synthesises a seed query from tags when no names are given", () => {
    const q = synthSeedQuery({
      genres: ["indie", "folk"],
      moods: ["chill"],
      eras: [],
      seedNames: [],
      exclude: [],
      length: 25,
    });
    expect(q.trim().length).toBeGreaterThan(0);
    expect(q.toLowerCase()).toContain("indie");
  });
});
