# ADR-0007: LLM in the music recommender — prior + intent, never the song-picker

- **Status:** Accepted — implemented 2026-08-04. **Provider superseded by ADR-0011** (2026-08-24): the LLM *roles* below still hold, but the vendor is no longer Z.ai/GLM — every mention of GLM / `ZAI_*` now means OpenCode Go `gpt-5.6-luna` behind `lib/ai/llm.ts` (`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`).
- **Scope:** `lib/music/` (tags, similarity, recommend, vibe), `app/api/yt/vibe`, the Music widget, migration `0020`

## Context

The music recommender is a two-stage **behavioural** pipeline that **converges with the
listener's own data** (learned `music_transitions`, skip/complete/like signals). Its defining
property is **anonymity** — signed-out InnerTube candidate generation, no credential in the path.

The question was whether to bring an LLM in as a **judge / song-picker / recommender**, for two
goals: (1) improve default recommendations, and (2) a new "vibe" (natural-language) surface.
Constraint confirmed by the owner: server-side GLM (`glm-5.2`) is fair game and music metadata is
not sensitive. The governing test for any LLM role: *does it help where behavioural signal is
weak, without replacing the parts that learn?*

## Decision

The LLM is used in **two roles only**:

1. **Cold-start similarity prior** (`similarity.ts`). Where two tracks share no co-occurrence
   source — the one place the behavioural system is blind — their LLM tag cosine fills in, faded
   by an evidence-weighted gate (`wPrior = 1/(1+evidence)`): any real co-occurrence overlap
   overrides the prior. The non-decay rule on the co-occurrence graph is preserved.
2. **Intent parser for the vibe surface** (`vibe.ts` + `app/api/yt/vibe/route.ts`). GLM maps a
   free-text prompt onto fixed-vocabulary tags + a concrete seed; the seed is resolved to a real
   videoId via YouTube search (grounding — no free-form titles, no hallucinated ids), then the
   **existing** `buildRadio` fulfils it, personalised to the listener.

Both share one foundation: a **constrained-vocabulary** tag layer (`tags.ts`, cached per track in
`music_track_tags` via the service-role client). The LLM is **never** the song-picker/ranker.

### Why (the evidence, with trust tiers)

- **Convergent industry practice (official / production):** every major DSP ships the LLM at the
  intent / grounded-candidate layer and **none** ship an LLM ranker — Spotify GLIDE (KDD 2026:
  *"acts as an additional candidate generator … rather than replacing … the ranking pipeline"*)
  + NEO/Semantic IDs; YouTube Music "Ask Music" (Gemini) over a Transformer + MuLan ranker;
  Apple Playlist Playground; Deezer Text2Playlist; NetEase Melo/Muse Mix.
- **LLM-as-rerank loses off-domain (preprint, directional):** in cold-start, LLM/cross-encoder
  reranking was beaten by *popularity* ranking (Zmanovskii 2026, movies). Not a music number —
  the load-bearing proof is the convergent practice above + GLIDE's own framing.
- **LLM-as-judge pitfalls (preprint, consistent):** LLMs rerank short lists well but degrade as N
  grows and carry strong position bias (LLM4Rerank; arXiv 2508.02020; InvariRank).
- **Cold-start prior helps (preprint):** LM-derived item similarity as a Bayesian prior lifts
  cold-item metrics (AWS, arXiv 2411.09065); constrained-vocabulary LLM tags beat free-form
  (AgenticTagger, arXiv 2602.05945).
- **Field/community:** Spotify's AI DJ fails publicly on grounding/structure (Petzold 2026;
  Sipoch 2026) — which is *why* our rule is "constrain to a vocabulary + ground via the retriever."
  HN/Reddit: users want steerability + negative signal; recs feel bubble-bound — the pain our
  ε-greedy + skip/like signals and the vibe surface address.

**Honest gap:** the "LLM rerank loses" claim rests on one movie-domain preprint; niche DSPs
(Tidal/SoundCloud/Pandora/Last.fm) don't publicly document a 2026 stance. We have no live A/B of
our own — the offline eval in `tests/music-cold-start-eval.test.ts` is the first mechanism-level
evidence for this app.

## Consequences

- Adds a **first-build** GLM cost per cold track, then cached forever in `music_track_tags` (no
  per-request hot-path cost).
- A server key (`ZAI_*`) now sits in the music path — on **track metadata only**, never user
  identity, so the path is effectively anonymous still.
- The behavioural ranker + learned transitions remain the asset; the prior fades the instant
  co-occurrence exists; the layered decay is untouched (similarity never decays, ranking does).

## Deferred — top-N LLM diversity judge

The "LLM-as-judge over the top ~12" is **not day-1**. It is gated, not calendared:

- **Only after** Goal 1 + Goal 2 have shipped and collected real usage data.
- **Only over the top ~12** of the ranked slate (short-list regime where LLMs rerank well), for
  clunker / jarring-transition detection, **with position-bias mitigation** (shuffle + bootstrap,
  or RISE iterative selection).
- **Only if** cold-item coverage and vibe skip-rate **plateau below parity** and qualitative
  complaints about clunkers persist — i.e. measured headroom exists.
- **Never** on the per-request hot path without an offline/cached budget.

See the answer accompanying this ADR for the "when."

## References

- Spotify Research: *From Models to Products — LLMs for Recommendation at Spotify Scale*
  (GLIDE/NEO, KDD 2026); *Semantic IDs Enable Personalization* (2025); *Text2Tracks* (2025);
  *Parallel Fusion Router* (2025); *Hypothesis-Driven Shelf Generation* (arXiv 2607.25823).
- Google Research: *Transformers in music recommendation* (YouTube Music); YTM *Ask Music*
  (Music Business Worldwide 2026).
- Deezer *Text2Playlist* (arXiv 2501.05894); NetEase *Melo/Muse Mix* (arXiv 2607.23718).
- Zmanovskii, *Diagnosing LLM-based Rerankers in Cold-Start* (alphaXiv 2604.16318);
  AWS *Language-Model Prior* (arXiv 2411.09065); *AgenticTagger* (arXiv 2602.05945);
  position-bias (arXiv 2508.02020); *InvariRank* (2604.27599); *LLM4Rerank* (2406.12433).
- Field/community: Petzold 2026; Sipoch 2026; HN threads; r/YoutubeMusic, r/musichoarder;
  Musically *State of Music Streaming 2026*; Music Tomorrow 2026.
