# ADR-0010: Taste-signal fidelity — likes and repetition drive candidate generation, not just ranking

- **Status:** Accepted — implemented 2026-08-12
- **Scope:** `lib/music/recommend.ts` (`buildShelf` Stage 1d + endorsed set), `lib/music/ranking.ts` (`confidence`, `assemble`, exported `primaryArtist`)
- **Depends on:** ADR-0009 (operates on a correctly-sourced pool)

## Context

Two pieces of listener feedback after the Slice B fix, both about the recommender *learning from behaviour*:

1. **Liked discoveries didn't propagate.** The listener liked *Good Without* (Mimi Webb) and *Unethical* (Faouzi) off a Listen-Again shelf, but subsequent shelves rarely surfaced similar tracks. A like on a freshly-discovered track did **not** cause the engine to fetch that track's neighbourhood — it only biased seed selection (where `likeBoost=3` lost to `playCount=10+`) and the confidence term (which applies only to candidates *already in the pool*). So a like was a dead-end signal.
2. **High-frequency repetition was flattened and capped out.** The listener repeats liked-shelf songs heavily — a strong "what I want right now" signal. But `PLAY_CAP=12` made a track played 50× score identically to one played 12×, and `maxPerArtist=3` suppressed exactly the artist concentration that *is* the taste statement, with no exemption for endorsed artists.

Both are the same gap with two faces: the listener's strongest, least-ambiguous signals (a like, a heavy repeat) were influencing *ranking* of an already-English pool but were not driving *candidate generation*, and the ranking terms that did exist flattened/capped precisely where the signal is richest.

## Decision

Three changes that make likes and repetition first-class at candidate generation + signal weighting. None names language, none hardcodes an artist, all key on the listener's own observed behaviour.

### C1 — Likes are a fanout trigger, not just a seed competitor (`buildShelf` Stage 1d)

After the seeded fanout, `buildShelf` fetches song-radio around **`LIKE_FANOUT` (=2) liked tracks that were not picked as seeds** — guaranteed, not competing for one of 4 seed slots. Selection is most-recent-first (so the listener's *most recent* taste leads) with a rotating start offset, so different liked neighbourhoods are explored across builds (both Mimi Webb's *and* Faouzi's, over refreshes) rather than always the same two. The radio enters the pool at origin `radio`, `seedWeight = LIKE_SEED_WEIGHT (=3)` — a like carries roughly the seed-trust of a moderately-endorsed seed (consistent with `W_LIKE`'s "one like ≈ five completed plays"). This is the direct fix for Feedback 1: liking a discovery now propagates into "more like this."

No double-counting with the confidence term: the fanout fetches *neighbours* of the liked track (radio drops the seed), which are new tracks with neutral confidence; the liked track's own `W_LIKE` applies only if it itself surfaces.

### C2 — Repeat fidelity (`confidence`)

The flat `Math.min(playCount, 12) * W_PLAY` is replaced by `playEvidence()`:
- **linear** `min(playCount, PLAY_CAP) * W_PLAY` up to `PLAY_CAP=12` — **identical to the old term below the cap**, so no rebalancing of existing behaviour;
- then a **slow log tail** `+ log2(playCount − PLAY_CAP + 1) * W_PLAY_TAIL (0.1)` beyond it.

So a track at 12 plays scores exactly what it did before; a track at 50 plays now scores ~1.27 instead of the flattened 0.72. Heavy repetition — the listener looping their liked shelf — keeps rising instead of being ceilinged. The play term still never decays (decay remains recency's job, unchanged).

### C3 — Endorsed-artist cap relaxation (`assemble`)

`maxPerArtist` now relaxes for primary artists the listener has **explicitly liked** (the set is derived from `likes.map(l => primaryArtist(l.channel))` at the call site): `endorsedCap` defaults to `2 × maxPerArtist`. Rationale: the cap exists to stop *unendorsed* candidate clumping; an artist the listener is actively repeating in their liked shelf is endorsed taste, not clumping. The exemption is **behaviour-driven** (it follows the listener's likes) and **bounded** (not infinity), so it can't let one artist flood — and if taste shifts, the endorsed set shifts with it.

`primaryArtist` is now exported so `buildShelf` can compute the endorsed set with the same definition `assemble` uses internally. `buildArtistCatalog` (already `maxPerArtist = Infinity`) and `buildRadio` (conservative autoplay; its `likes` is videoId-only, no channels) are unaffected.

## Why not the alternatives (hardening traps)

- **No "≥ N liked tracks per shelf" quota** — that's a hardening hack contradicting the discovery-shelf intent; C1 makes likes *generate* candidates, not reserve slots.
- **No inflating `likeBoost`** in `pickSeeds` to force liked seeds — the failure was structural (likes didn't fan out), not a magnitude-tuning problem.
- **No `language`/artist static registry**, no "force N songs by artist X" — C3's exemption keys on the listener's live like set, never a constant.
- **No bypassing recency for likes** (e.g. floor = 1.0) — would recreate the "same songs on a loop" problem; the existing 0.35 like-floor stays.
- **No injecting likes as a full-strength origin *and* full-strength confidence** — double-counts; C1 uses the radio origin + a bounded seedWeight and lets confidence act on whatever surfaces, mostly neutral neighbours.

## Consequences

- Liking a shelf discovery now causes similar tracks to appear in subsequent shelves (Feedback 1).
- Heavily-repeated liked tracks outrank moderately-played ones instead of being flattened (Feedback 2); endorsed artists are no longer capped out of their own shelf.
- One additional fanout source in `buildShelf` (≤2 cached, parallel radio calls per build); `buildRadio` and `buildArtistCatalog` untouched.
- The play/confidence balance is unchanged below `PLAY_CAP`; only the heavy-repeat tail grows.

## References

- Listener feedback 2026-08-12 (liked-discovery propagation; high-frequency liked-shelf repetition as most-recent-taste).
- `docs/adr/0006-music-likes-as-reward-signal.md` (the Hu/Koren/Volinsky confidence term C1/C2 extend); `docs/adr/0009` (the correctly-sourced pool this operates on).
