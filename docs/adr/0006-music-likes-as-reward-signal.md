# ADR-0006 — Likes are a first-class reward signal; the imported YouTube "Liked Music" is only a cold-start prior

- **Status:** Proposed (2026-08-03)
- **Decided in:** competitor research session (agent-reach → Exa / Jina / gh; Reddit backend produced
  off-target results and was **not** used — see "Evidence quality" below)
- **Related:** the recommender shipped in `5e18201` (`lib/music/`), CLAUDE.md § Music recommendations

Evidence markers used throughout, per the project's research discipline:
**✅** verified first-hand (command run / page opened / real response seen) ·
**📄** clear source, not independently verified · **❓** found but unconfirmed.

## Context

The recommender shipped in `5e18201` learns from two behavioural signals: a play, and a skip
inside 30 s (`music_plays.skip_count` / `complete_count`, plus `music_transitions`). It has **no
explicit positive signal at all**. The strongest thing a listener can currently say about a track
is "I did not skip it", which is a weak and ambiguous statement.

Separately, the app surfaces a **"Liked" shelf** that reads YouTube's `LM` playlist over the
official Data API ✅ (`features/dashboard/music/music-widget.tsx:95`, `lib/google/youtube.ts`
`LIKED_MUSIC_ID = "LM"`). That list is imported from the user's Google account, may be years old,
is unbounded in size, and today feeds **nothing** — it is display-only.

Two questions follow: should that imported list train the recommender, and what should an
in-app "like" actually be?

## What the incumbents do

**Explicit likes are a real input, but a weaker one than sustained listening.**
Spotify's own recommendations page ✅ (read via Jina Reader, "last updated March 12, 2026") lists
the taste-profile inputs as "searching, listening, skipping, or **saving to Your Library**" — a
save sits alongside listening, not above it. A long-standing Spotify Community answer 📄 puts it
more bluntly: songs you like *and play a lot* affect Discover Weekly and Release Radar, but a
track you like once and never return to "has no impact on your personal recommendations".

**The reward is shaped, not binary.** Spotify's RL sequencer 📄 defines reward from a binary
relevance term where a skip yields a small negative constant (`c = 0.1`), with a diversity term
*multiplied* by relevance so diverse tracks only pay off when they are also relevant. An earlier
contextual-bandit paper 📄 reports that replacing a binary "streamed / didn't" reward with a
co-clustered, distribution-aware reward improved expected stream rate by **over 25 %** — i.e. the
shape of the reward mattered more than the model. Their 2025 agentic work 📄 goes further and
trains an explicit **reward model + DPO** (RLHF-style), reporting +4 % listening time and more
saves in production A/B.

**Negative signals are shipped as deliberate product surface, not just inferred.** Spotify's
controls, verified on their own pages ✅: *exclude a playlist **or a track** from your taste
profile*, *thumbs down / not interested*, *Hide in this playlist* (syncs across devices), and
*Snooze* (Premium — suppress a track from recommendations for 30 days) 📄.

**Apple Music consolidated "Love" into "Favorites".** As of iOS 17.1 the heart became a star 📄;
favouriting a song adds it to the library (toggleable in Settings) and, from iOS 17.2, populates
an **auto-updating "Favorite Songs" playlist** 📄. Apple's own support page states that
favouriting an artist causes their music to be "recommended more often" ✅ (page read). Favourites
also seed Apple's in-playlist "Song Suggestions" 📄.

**Hard constraint discovered.** Writing a like *back* to YouTube is not available to this app:
`videos.rate` requires `youtube`, `youtube.force-ssl`, or `youtubepartner` ✅ (Google's own API
reference, read directly), while the app requests only `youtube.readonly` ✅
(`app/login/login-form.tsx:96`). Upgrading the scope would re-open Google OAuth verification,
which is already blocked on this project for an unrelated reason. **Likes must therefore be
stored locally.** This is a constraint, not a preference.

## Decision

**1. An in-app like is a first-class signal, stored locally, and it is the strongest positive.**

Add `music_likes` (or a `liked_at` column on `music_plays`). In `lib/music/ranking.ts` the
signal hierarchy becomes, strongest to weakest:

| Signal | Direction | Rationale |
|---|---|---|
| liked | strong + | explicit; the only unambiguous positive we have |
| completed play | + | passive positive, already implemented |
| play started | weak + | already implemented |
| skip < 30 s | strong − | already implemented |
| hidden / not-interested | hard − | new; suppress rather than down-rank |

A like must do **three** things, not one: boost the track, boost its neighbourhood (its radio
becomes a preferred seed in `pickSeeds`), and never be silently overridden by a recency penalty.

**2. A like decays in influence unless it is re-listened.**

Per the Spotify Community observation 📄 and the "dynamic taste" requirement: a like from 8 months
ago that was never replayed should not pin the profile. Weight a like by
`likeWeight × recencyDecay(lastPlayedAt)` rather than treating it as permanent. This is what makes
the profile follow taste changes instead of accumulating a permanent floor.

**3. The imported YouTube "Liked Music" is a COLD-START PRIOR ONLY — kept, but demoted.**

Keep the shelf (it is genuinely useful to browse and play), but:

- **Do not** feed it into `pickSeeds` at the same weight as in-app behaviour.
- Use it **only** when in-app history is thin (< ~10 plays), as a seed source to bootstrap.
- Once real in-app history exists, its weight decays toward zero.
- Give the user an explicit **"use my YouTube likes for recommendations"** toggle, default
  **on** during cold start, and an exclusion control thereafter.

Rationale: it is imported, potentially years stale, unbounded (a 2 000-track legacy list would
swamp a 4-seed selection and freeze the listener in their 2019 taste — the exact failure the
recommender was built to fix), and read-only ✅ so the app cannot keep it in sync. Spotify shipping
*exclude-from-taste-profile* for tracks and playlists ✅ is direct evidence that the incumbents
treat "library content that isn't really your current taste" as a problem needing an escape hatch.

**4. Ship the negative controls alongside the like, not later.**

A like-only system is half a feedback loop. Minimum: **Not interested** (hard suppress) and
**Snooze 30 days** (temporary), mirroring the verified Spotify control set ✅.

## UI/UX decisions

Drawn from documented failures of the incumbents, not from imitation:

- **One button, one job.** Spotify's like affordance conflates "add to Liked Songs" with "add to
  a playlist" (heart → plus → context-dependent checkmark); it is their single most-criticised
  interaction 📄, including a design-teardown proposing exactly the split we adopt: `♡` for like,
  a separate control for playlist. We ship a dedicated `♡` and nothing else on the row.
- **Never put a destructive toggle under a scrolling thumb.** Spotify Community reports repeated
  *accidental un-likes* from the heart rendered on every row of the Liked Songs list, with the
  track effectively unrecoverable 📄. In our Liked shelf the row heart therefore either requires
  confirmation or is demoted to the overflow menu — and every like/unlike raises an **undo toast**.
- **Immediate, explicit feedback.** A Pratt design critique 📄 notes that Spotify's "Added to
  Liked Songs" toast is what teaches the otherwise-undiscoverable swipe gesture. Optimistic UI
  + toast, reconciled on server response.
- **The liked store is an auto-playlist, not a settings page.** Apple's auto-updating "Favorite
  Songs" playlist 📄 is the right model: liking is the only curation step; the shelf assembles
  itself.
- **Surface why.** Our recommender already tracks provenance (`Candidate.occurrences`,
  `CandidateOrigin`). A "Because you liked X" label is nearly free and is the honest version of
  the black box both incumbents are criticised for.

## Consequences

**Positive**

- Closes the last missing term in the reward function: the recommender currently cannot tell
  "tolerated" from "loved".
- Likes are local, so no OAuth scope upgrade and no re-verification ✅.
- The cold-start prior solves the empty-history problem without letting a stale import dominate.
- Decay + exclusion make the profile *dynamic*, which is the stated success criterion.

**Negative / accepted**

- Likes live only in this app; they do not appear in YouTube Music. Unavoidable ✅ given the scope
  constraint, and worth stating plainly in the UI.
- One more schema migration and one more write path per interaction.
- Reward weights are initially guesses. They should be tuned against observed skip rate, not
  asserted — the incumbents' own numbers came from A/B tests we cannot replicate at this scale.

## Evidence quality

- Spotify's recommendations/controls pages and Google's `videos.rate` reference were **read
  directly** ✅; claims sourced to them are quoted, not paraphrased from search snippets.
- Vendor pages describe the vendor's own system and are marked 📄 where used as fact about
  mechanism, per the "厂商自己的页面 ≠ 事实" rule.
- **Reddit was attempted and abandoned.** Three queries via `opencli reddit search` returned
  off-target results (r/indieheads album write-ups, r/lastfm tool lists). No community sentiment
  is claimed anywhere in this ADR. Falling back to built-in `WebSearch` was explicitly declined.
- No GitHub repositories are cited, so no `pushedAt` health checks were required.
