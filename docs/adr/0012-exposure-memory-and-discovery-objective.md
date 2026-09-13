# ADR-0012: Exposure memory and a discovery objective — stop Listen Again recycling its own history

- **Status:** Accepted — implemented 2026-09-14
- **Scope:** `lib/music/{exposure,language,objective,ranking,recommend,events-store,store}.ts`, `app/api/yt/{plays,signals}/route.ts`, `features/dashboard/music/{music-widget.tsx,use-yt-player.ts}`, migration `0021_music_exposure_memory.sql`
- **Supersedes in part:** ADR-0009 (its "no language field" decision), ADR-0010 (its uncapped play evidence)

## Context

After months of use, Listen Again presented a loop of familiar songs rather than
taste-compatible discoveries. Six prior iterations improved retrieval breadth,
signal fidelity, sequencing and cold start, and every one of them was green,
because every one measured a single generated shelf. The defect is a property of
the *sequence* of shelves, so no single-shelf test could see it.

Measured on the working tree before any change (`tests/music-repetition-diagnostic.test.ts`,
28 previously played candidates against 12 unseen, five plays and four
completions each, 20 slots, 50 seeds):

| Probe | Before |
|---|---:|
| Previously played share, 1 day after play | 44.8% |
| Previously played share, 7 days after play | 96.9% |
| Previously played share, 20 days after play | 96.9% |
| Mean consecutive-shelf Jaccard | 90.5% |
| Score of a play evicted from the 60-row window | 1.0, identical to unseen |

Four structural causes, all verified in source:

1. **No exposure memory.** `music_plays` is an aggregate. Nothing recorded what
   was *shown*, so "offered twelve times and ignored" was unrepresentable.
2. **No discovery term.** `score()` was `source × confidence × recency`. Nothing
   in it referred to novelty, so a better ranker just got better at familiarity.
3. **An unbounded multiplier racing a bounded one.** `confidence` grew without
   limit as plays accumulated; the recency penalty was capped at 1 and neutral by
   day 14. Familiar therefore overtook unseen by roughly day seven *by shape* —
   no choice of constants inside that form avoids it.
4. **Memory was 60 rows.** `loadHistory` caps at 60, and that cap had silently
   become the whole memory: an older play scored exactly like a never-heard song.

Plus `staleTime: Infinity` on the client (the shelf never expired at all),
epsilon sampling the unused tail of its own ranking (so "exploration" could not
reach anything retrieval had not already chosen), and a player that recorded
skips only under 30 seconds — leaving every late abandon and partial listen
unrepresented, and every autoplay start counted as a preference.

## Decision

### 1. Exposure memory as an immutable event stream (`exposure.ts`, migration 0021)

`music_play_events` and `music_impressions` are append-only. Aggregates remain as
projections and are no longer the source of truth. Events carry `origin`
(manual/search/playlist/autoplay/radio/unknown), `outcome`
(completed/substantial/late_skip/early_skip/unknown) and `duration_ratio`.

`loadEverPlayed` answers "ever played?" from an **unwindowed** id query. This is
the direct fix for cause 4 and needed no migration.

### 2. Repeat readiness instead of a seen/unseen flag

Affinity says what belongs in the taste graph; **repeat readiness** says whether
it should be served now. Readiness recovers on an exponential curve whose
half-life is set by measured enjoyment — a loved track returns sooner, a
tolerated one later — and is pushed back down by impressions that never convert.
A never-played track is always 1.

Banning everything already heard was rejected: music is a domain where people
deliberately replay favourites, and resurfacing an enjoyed discovery increases
later revisiting (Schedl et al., ISMIR 2020).

### 3. A bounded objective (`objective.ts`)

```
utility = relevance × (affinity × readiness + discoveryBonus) + languageFit − groupFatigue
```

`affinity ∈ [1, 1.8]` and `readiness ∈ [0, 1]`, so freshness can actually
outweigh accumulated history. This bounds ADR-0010's uncapped `playEvidence`
tail, which was correct for "more of what I repeat" and wrong once the goal was
stated as discovery.

### 4. Pool quotas instead of one ranking plus a tail

Five pools — familiar-anchor, rediscovery, adjacent-discovery, cross-discovery,
exploration — each competing only for its own quota, with discovery taking 85%.
Membership is decided before any competition, so a quota cannot be satisfied by
relabelling. Unfillable quota is redistributed to discovery pools *before*
anything reaches generic backfill.

Within a pool, selection is **softmax over utility** rather than argmax. This was
the fix for cross-shelf sameness: inside one pool most candidates score almost
identically, and a stable sort plus argmax turns "almost identical" into "always
the same track".

### 5. Retrieval that can reach outside the bubble

Seed cooldowns (a song radio is ~deterministic per seed, so reusing seeds
regenerates the same neighbourhood) and an exploration fanout drawn from the
*far* end of the adjacency lists, marked at generation time — a ranker cannot
tell "outside the bubble" from "badly matched" after the fact.

### 6. Vocal language as a first-class attribute (`language.ts`)

This reverses ADR-0009's "no language field". That decision was right for the bug
it faced — the pool really was mis-sourced upstream — but it left availability,
exposure and acceptance per language unmeasurable, so "Chinese never appears" and
"Chinese appears and is always skipped" were indistinguishable.

Evidence is weighted by how much each source actually narrows the answer: kana is
near-decisive, Han leaves a real Chinese/Japanese ambiguity, Latin script barely
narrows anything. Two thresholds, because the uses differ — a probable label may
balance a slate, but only a corroborated or near-decisive one may train the
long-term target, since a wrong learned target reinforces itself. `instrumental`
and `unknown` are real answers.

**ADR-0009's rejection of a hardcoded quota still stands.** The mix is *learned*
from deliberate positives over two horizons, with a floor that protects any
language with sustained evidence from being squeezed out (Steck, 2018).

### 7. Feedback semantics

A late abandon is now a weak negative and a substantial listen a real positive,
separated by duration ratio. Autoplay is damped rather than counted as a choice.

### 8. Bounded shelf age

`staleTime` is six hours, with focus/reconnect refetch still off. That keeps a
listening session stable — which was the point of the freeze — without a desktop
session displaying the same forty tracks indefinitely.

## Results

90-day simulation with feedback (`tests/music-longitudinal.test.ts`):

| Metric | Result |
|---|---:|
| Previously played share of the shelf | 24.9% |
| Discovery slots that are genuinely new | 100% |
| Re-served within 7 days of a play | 4.9% |
| Mean consecutive-shelf Jaccard | 0.083 |
| Mean week-apart Jaccard | 0.074 |
| Distinct artists reached | 36 / 36 |
| Accepted discoveries / later revisited | 165 / 63 |
| Languages served and accepted | en, zh, ja all non-zero |

Health probes: 40.1–41.3% previously played at every age (flat — elapsed time no
longer flips the slate), Jaccard 0.594, evicted play 1.00 vs unseen 1.45.

## Consequences

- Retrieval failures are visible: `emptySources`, `backfilled` and a `degraded`
  flag distinguish a genuine 100%-familiar fallback from normal composition.
- `music_track_language` is written by any authenticated user (a track's language
  is not user data). Acceptable for a small trusted deployment; it would need
  tightening before public multi-tenant use.
- The repeat-readiness curve and the discovery bonus are **calibrated against a
  simulated listener**, not production response curves. The shapes are grounded;
  the constants need production telemetry to confirm.
- Impressions are higher-volume than plays. `prune_music_exposure` exists but is
  not scheduled.

## Rejected

- **A fixed CN/JP/EN quota.** Still rejected, for ADR-0009's reason: a measured
  share is an observation, not a target.
- **An LLM re-ranker.** Deterministic behavioural ranking stays inspectable; the
  LLM remains a constrained-vocabulary tag source and intent parser (ADR-0007).
- **Raising `SEED_COUNT`, `LIKE_FANOUT`, epsilon or the history limit.** Each
  leaves the objective and the memory unchanged, which is where the defect lives.
