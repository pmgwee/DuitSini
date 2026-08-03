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

**2. A like raises CONFIDENCE, not preference — and decay is applied to the user state, not to
item–item relations.**

*(This section was revised after a second research pass; the first draft said simply "a like
decays unless re-listened", which the literature contests. See "Revision" below.)*

Hu, Koren & Volinsky 2008 ✅ (paper read directly; winner of the 2017 ICDM 10-Year
Highest-Impact Award 📄) is the canonical treatment of exactly our situation, and it splits a
signal into **two** magnitudes rather than one:

- **preference** `p_ui` — binary. Did the user engage at all?
- **confidence** `c_ui = 1 + α·r_ui` — how sure are we? (α = 40 worked in their experiments ✅)

The insight that matters here: *"explicit feedback indicates user preference, whereas the implicit
feedback numerical value indicates confidence"* 📄. So a like is **not** a larger preference than a
play — preference is already 1. A like is a large jump in **confidence** that `p_ui = 1` is real.
Twelve plays and one like both say "yes"; the like says it with far less ambiguity. Our ranking
should therefore multiply a confidence term, not add a bonus.

On decay, the evidence is genuinely split and the naive reading is wrong:

- Ding & Li 2005 ✅ propose exponential time weights with a half-life `T0`, personalised per
  item-cluster, and report improved precision.
- **Koren 2009 (the Netflix-Prize-winning temporal-dynamics work) ✅ found the opposite**:
  *"prediction quality improves as we moderate that time decay, reaching best quality when there
  is no decay at all… just underweighting past actions lose too many signals along with the lost
  noise, given the scarcity of data per user."*
- A 2010 analysis 📄 finds decay is real but **piecewise** — a short-term component (< ~3 h), a
  plateau, then long-term drift beyond ~10 days — not one smooth exponential.

The reconciliation Koren himself gives ✅: *"we can deduce that two items are related if users
rated them similarly within a short time frame, even if this happened long ago."* Old data is
excellent for learning **relations**; it is bad for asserting **current state**. So:

| Layer | Decay? | Why |
|---|---|---|
| Item–item co-occurrence (`similarity.ts` vectors) | **No** | An old like still proves two songs belong together |
| Seed selection + ranking (`pickSeeds`, `score`) | **Yes** | This is a claim about what you want *now* |

This is the corrected version of the "dynamic taste" requirement: the profile tracks taste change
through **which seeds are chosen and how candidates are ranked**, while the similarity graph keeps
its full history. Decaying the graph would throw away the very signal that makes the graph work.

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

## Prior art, vetted

Checked first-hand with `gh repo view --json …pushedAt,createdAt,isArchived,isFork` ✅, because
`updatedAt` from search listings includes README/metadata edits and overstates activity:

| Repo | ★ | Last **push** | Created | Archived/Fork | Verdict |
|---|---|---|---|---|---|
| `benfred/implicit` | 3,806 | **2026-05-08** | 2016-04-17 | no / no | Healthy — the reference ALS implementation of Hu-Koren-Volinsky |
| `lyst/lightfm` | 5,107 | **2024-07-24** | 2015-07-30 | no / no | ⚠️ **~2 years without a push.** Highest-starred of the three and the one most tutorials still recommend for hybrid explicit+implicit — do not adopt on star count |
| `RUCAIBox/RecBole` | 4,524 | 2025-02-24 | 2020-06-11 | no / no | Slowing (~17 months); research toolkit, heavier than we need |

Two details in `implicit`'s source ✅ (read directly) are worth copying even though we will not
take the dependency — our pool is a few hundred candidates, not a factorisation problem:

- **Negative confidence is a first-class input:** *"Negative items can also be passed with a higher
  confidence value by passing a negative value, indicating that the user disliked the item."* That
  is exactly our skip signal, and it validates modelling skips as negative confidence rather than
  as absence.
- **`explain()` returns the top contributing past items** for a recommendation. That is the
  "Because you liked X" label, and we already carry the equivalent data in
  `Candidate.occurrences`.

## Revision (second research pass)

The first draft of this ADR recommended flatly that "a like decays unless re-listened". A second,
wider pass found that Koren 2009 ✅ reports the opposite result on Netflix data, and that the
correct move is to separate the layer that decays (user state) from the layer that must not
(item–item relations). Decision 2 above is rewritten accordingly. Recording this because the first
version rested on a single 2020 forum post 📄 and would have degraded the similarity graph.

## Evidence quality

- Spotify's recommendations/controls pages, Google's `videos.rate` reference, the Hu-Koren-Volinsky
  paper, the Koren temporal-dynamics paper, and `implicit`'s ALS source were **read directly** ✅;
  claims from them are quoted, not paraphrased from search snippets.
- Vendor pages describe the vendor's own system and are marked 📄 where used as fact about
  mechanism, per the "厂商自己的页面 ≠ 事实" rule.
- **Reddit:** `opencli reddit search` produced off-target results three times; `opencli reddit
  subreddit <name>` works ✅ and was used to browse r/truespotify and r/AppleMusic. Front-page
  content was largely support noise, so **no community sentiment is claimed in this ADR**. The one
  on-topic post seen — an r/AppleMusic complaint that unwanted content can only be answered with
  *"suggest less"* — is consistent with Decision 4 (ship real negative controls) but is a single
  data point and is not load-bearing.
- **Twitter/X and 小红书 were unavailable, not skipped:** both returned
  `AUTH_REQUIRED` ✅ (`no ct0 cookie` / `search results are blocked behind a login wall`). They
  need a one-time Chrome login. B站 via OpenCLI worked ✅ but surfaced mostly download/skin
  tutorials — no usable product analysis.
- Built-in `WebSearch` was **not** used at any point.
