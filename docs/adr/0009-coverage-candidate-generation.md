# ADR-0009: Coverage-biased candidate generation — make Listen Again reflect the whole taste graph

- **Status:** Accepted — implemented 2026-08-12
- **Scope:** `lib/music/ranking.ts` (`pickSeeds`), `lib/music/recommend.ts` (`buildShelf` Stage 1b), `lib/music/sources.ts` (`getClient`), `.env.example`

## Context

Live data for the primary listener (2026-08-12): play history is **~81% English / ~18% Chinese by weight** (39 likes: 87/13; 422 distinct played tracks). Chinese is a real minority taste (one Mandopop track in the top-10 most-played; `小情歌` 8×, `囍帖街` 7×, `心牆` 7×) — not noise. Yet Listen Again returned **0% Chinese**. The recommender was demonstrably under-representing taste, not reflecting it.

Diagnosis (5-agent workflow) localized the bug to **Stage 1 (candidate generation + seed selection)** — not the ranker, the co-occurrence graph, or the per-artist cap, all of which behave correctly inside whatever pool they're handed:

1. **`pickSeeds` sampled proportional to weight, not for coverage.** Weight = `playCount × recency × skipPenalty × likeBoost(3)`; `playCount` dominates, so with English-majority history 3 of 4 seed slots landed English. The docstring *promised* "deliberately spread," but weighted-proportional sampling **concentrates on the mode** — the gap between the promise and the code is where this bug lived.
2. **The 4th "long-tail" slot was oldest-played**, not a diversity criterion — also usually English.
3. **The related fanout ran from `seeds[0]` only** — so even when a Chinese seed *was* picked, its similar-artist / editorial shelves were never fetched.
4. **The InnerTube session was pinned to `hl='en' / gl='US'`** by library default — a region mismatch for a Malaysia-based audience, biasing the region-sensitive shelves (also-like / similar-artist / editorial) toward US/English yields.

The ranker's `confidence()`, `maxPerArtist`, ε-greedy, and the no-decay co-occurrence graph are all **correct as designed** — they were operating inside a pool whose language mix was mis-set upstream.

## Decision

Three structural fixes to **how the pool is sourced** — none of them name language anywhere:

1. **Coverage-biased seed selection** (`pickSeeds`). Each weighted slot now samples proportional to importance but **preferentially among entries whose primary artist isn't yet represented** (falling back to the full pool once every visible artist is covered). The sampler stays stochastic, so cross-build variety is preserved; the bias just makes a 4-seed draw *span* taste clusters (an English cluster **and** a Chinese one) instead of landing 3/4 in the mode. The oldest-played tail slot is kept for bubble-breaking. This realises the docstring's stated intent.

2. **Per-seed related fanout** (`buildShelf` Stage 1b). `fetchRelated` now runs for **every** seed (parallel, deduped-merged across seeds), not just `seeds[0]`. So a minority-taste seed's similar-artists and editorial shelves actually reach the pool. Cost: N related calls (was 1), all parallel and cached (`RELATED_TTL_MS = 6h`) — negligible wall-clock, and the shelf build already runs N radio calls in parallel.

3. **Region via env, not a hardcoded pin** (`sources.ts` `getClient`). The InnerTube session reads `YTM_LANG` / `YTM_LOCATION` from env; **unset → current en/US behaviour (zero regression)**. The Malaysia deployment sets `YTM_LOCATION=MY`. This is a **region** correction (which market YouTube curates for), **not a language quota** — it does not touch the recommendation output mix, which taste still decides. Pinning a hardcoded locale (zh-CN/MY) is explicitly rejected below.

### Why this is enough, and why the ranker is untouched

Radio is language-neutral *given a matching seed* (deterministic per seed). With (1) ensuring a Chinese seed is actually picked and (2) ensuring its neighbourhood is actually fetched, Chinese radio queues — the highest-yield source — enter the pool naturally. The ~18% measured taste then surfaces at roughly that share with **no language-aware code anywhere**. The ranker, the per-artist cap, and the co-occurrence graph require no change: they were never the cause.

## Dropped from the plan: tag-cache coverage (B4)

The investigation hypothesized a path that *filters candidates to tag-present rows*, which (given `music_track_tags` covers only ~42% of played tracks, Mandopop over-represented in the missing set) would silently drop history. **Verified false**: tags are consumed as a **sequencing prior only** (`similarity.ts` `tagVectors?.get(...)`, undefined → fall back to pure co-occurrence). Nothing in candidate generation or assembly filters by tag presence. So the 42% coverage affects sequencing smoothness, not *which* tracks surface — orthogonal to this symptom. A future refinement (background-tag high-play tracks) can improve the sequencing prior; it is not needed for the language-skew fix.

## Why not the alternatives (hardening traps)

- **No language quota / split** (e.g. "≥15% Chinese", 50/50 EN/CN). The measured share is an *observation*, not a target; a quota freezes today's mix and can't adapt if taste shifts. Rejected — and it is the explicit anti-pattern the owner ruled out.
- **No `maxPerLanguage` cap** (a language analogue of `maxPerArtist`) — masks concentration at the slate level while leaving the pool English-dominated.
- **No language multiplier in `score()`**, no post-blend by detected CJK, no `language` field on the data model — all bake language into logic that should be behaviour-driven.
- **No hardcoded locale pin** (zh-CN / MY as a constant). The fix derives region from deployment env, not a code constant — and leaves the recommendation mix to taste.

## Consequences

- Listen Again now reflects the measured taste distribution (~18% Chinese surfaces ~1-in-5) with no language-aware code.
- `pickSeeds` picks more diverse seeds; `buildShelf` does N related calls instead of 1 (parallel + cached).
- Operators set `YTM_LOCATION` for non-US deployments; unset preserves prior behaviour.
- The song-radio path (`buildRadio`) and vibe catalog path (`buildArtistCatalog`) are untouched.

## References

- Diagnosis: 5-agent workflow 2026-08-12 (recRank + sources + likes + db agents); live taste profile from the `music_likes` / `music_plays` tables.
- `docs/adr/0007-llm-in-music-recommender.md` (the two-stage behavioural architecture this preserves); CLAUDE.md music section (radio determinism, layered decay).
