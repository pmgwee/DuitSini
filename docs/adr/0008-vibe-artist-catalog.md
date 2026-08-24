# ADR-0008: Vibe artist-catalog — "top songs by X" returns the catalog, not a radio

- **Status:** Accepted — implemented 2026-08-12
- **Scope:** `lib/music/vibe.ts`, `lib/music/recommend.ts` (`buildArtistCatalog`), `lib/music/sources.ts` (`resolveArtistId`), `lib/music/ranking.ts` (`ORIGIN_WEIGHT`), `lib/music/types.ts` (`CandidateOrigin`), `app/api/yt/vibe/route.ts`

## Context

User report: prompting the vibe surface (LLM intent parser — GLM at the time; see ADR-0011) with *"generate top songs by the chainmokers"* returned a random-ish list of songs by *other* artists, not The Chainsmokers' catalog, and not ordered by recognition.

The root cause is structural, not a tuning bug (diagnosed 2026-08-12 against the live code):

1. `parseVibe` collapsed every named entity into `seedNames` with **no artist-vs-song discriminator** — the docstring already extracted "a specific artist or artist - song," the code just flattened both.
2. Grounding resolved the artist name to **one search-hit videoId** (`resolveFirstVideoId`, `maxResults=1`), never to a YouTube Music **channel id (`UC…`)** — so "the artist's own catalog" was unreachable from this path.
3. `buildRadio` then generated candidates from song-radio (`getUpNext`) **only** — a diversity-calibrated autoplay slate of *many similar artists* (CLAUDE.md: `corr(rank, similarity) = -0.145`), not a catalog.
4. The right source already existed — `fetchArtistSongs(artistId)` reads the artist's Songs shelf, which YouTube Music **orders by popularity** — but it was wired only into `buildShelf`'s similar-artist fanout, never into the vibe path.
5. The one per-artist rule (`maxPerArtist`) is a **diversity cap** — it actively prevents the artist concentration the user is asking for.
6. No popularity signal exists anywhere (`MusicTrack` has no `viewCount`; `score()`'s positional term is source-queue order, not recognition).

So the surface treated every prompt as "personalized radio around a seed track" and discarded the artist identity.

## Decision

Add a distinct **artist-catalog** fulfilment path for the "named artist" intent, leaving the song-radio path intact for named songs. Four changes, all additive:

1. **`parseVibe` separates `artists` from `seedNames`** (`vibe.ts`). The LLM now returns `artists[]` (a specific artist whose catalog/top songs the user wants — "top songs by X", "best of X") distinct from `seedNames[]` (a song or "artist - song" to seed from). The field is optional on `VibeConstraints` so callers and existing literals stay valid.

2. **`resolveArtistId`** (`sources.ts`) resolves an artist name → channel id (`UC…`) via signed-out `yt.music.search({ type: "artist" })`, returning the first artist browseId. Null on any miss → the caller falls back to song-radio with the artist name as the seed query.

3. **`buildArtistCatalog`** (`recommend.ts`) reads the artist's Songs shelf via `fetchArtistSongs` and runs the **existing** learned-taste ranker over it:
   - candidate set = the catalog only (neighbours are **not** mixed in — the listener asked for that artist);
   - `ORIGIN_WEIGHT["artist-catalog"] = 0.95` (new origin, on par with radio);
   - **no per-artist cap** (`maxPerArtist = Infinity`) — the whole slate is one artist by intent;
   - **pure exploitation** (`epsilon = 0`) — the listener wants the TOP songs, not deep cuts;
   - the shelf's natural `rank` **is** YouTube's popularity order, so `rankWeight(rank)` yields top-down recognition with **no `viewCount` fetch**.

4. The **route** branches: when `constraints.artists[0]` resolves to a channel id, it calls `buildArtistCatalog`; otherwise it falls through to the existing `buildRadio` path (unchanged).

### The taste layer is not bypassed

A Chainsmokers catalog song the listener has **skipped** still sinks (`confidence` negative-evidence term); a **liked** one rises (`c = 1 + α·r`); recent repeats weigh in via the recency term. So the ranker learns taste *on top of* the catalog rather than being disabled for artist queries. Popularity dominates ordering; taste nudges within it — which is exactly "list based on song popularity from top to down," with the listener's endorsements honoured.

## Why not the alternatives

- **Post-hoc `tracks.filter(t => t.channel.includes(seed))`** — brittle (channel-name spelling, " - Topic" suffix already stripped), and it is a filter bolted onto a pool that still lacks the catalog. Rejected.
- **A "≥ N songs by X" quota** — the explicit anti-pattern (hard-coding, not learning). Rejected.
- **A `viewCount` Data-API fetch for popularity** — global-signal hardening; adds quota cost + a new failure mode without fixing the structural deficit (the catalog still wouldn't be in the pool). The shelf's positional rank already encodes recognition. Rejected.
- **Globally raising `maxPerArtist`** — that cap protects radio diversity; the right move is to disable it *for this mode only*, not globally. Done via the `Infinity` passed to `assemble` in `buildArtistCatalog`.

## Consequences

- "top songs by X" now returns X's catalog, recognition-ordered, with learned taste layered on top.
- Adds one signed-out `music.search` call per artist-named vibe request (cached InnerTube client; cheap).
- The song-radio path and `buildShelf` are untouched — no regression to Listen Again / autoplay.
- `CandidateOrigin` gains a member; `ORIGIN_WEIGHT` is a `Record<CandidateOrigin, number>` so the compiler enforced that the new origin got a weight.

## References

- Diagnosis: 5-agent workflow 2026-08-12 (vibe-route agent) + `docs/adr/0007-llm-in-music-recommender.md` (the "LLM is intent, never song-picker" rule this extends with an artist discriminator).
- CLAUDE.md music section: `fetchArtistSongs` and the `corr(rank, similarity) = -0.145` finding on radio order.
