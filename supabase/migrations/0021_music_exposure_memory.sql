-- ============================================================================
-- Exposure memory for the music recommender.
--
-- WHY: the recommender could say what the listener liked but not what it had
-- already shown them. `music_plays` is an aggregate — one row per track, a
-- counter and a last-played timestamp — so three questions that decide whether
-- a shelf feels fresh were simply unanswerable:
--
--   * was this recommended and ignored?           (no impression record)
--   * did they choose it, or did autoplay?        (origin was never stored)
--   * did they stay past 30s but not finish?      (neither skip nor completion)
--
-- Without those, affinity is the only signal that exists, affinity only grows,
-- and the shelf converges on a neighbourhood it has already exhausted. These
-- tables are the missing half. The aggregates stay as projections; they are no
-- longer the source of truth.
--
-- Events are immutable and append-only. They are deliberately NOT upserted into
-- counters: a counter cannot answer a windowed question ("shown how often in
-- the last 7 days?"), and every previous attempt to reconstruct behaviour from
-- counters is why the 60-row history window silently became the whole memory.
-- ============================================================================

-- ── Playback events ─────────────────────────────────────────────────────────
create table if not exists public.music_play_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  occurred_at timestamptz not null default now(),
  -- How the play STARTED. An autoplay start is not a statement of taste, and
  -- treating it as one is how a long background session rewrites the profile.
  origin text not null default 'unknown'
    check (origin in ('manual', 'search', 'playlist', 'autoplay', 'radio', 'unknown')),
  -- How it ENDED. `substantial` is the state the old schema could not express.
  outcome text not null default 'unknown'
    check (outcome in ('completed', 'substantial', 'late_skip', 'early_skip', 'unknown')),
  -- Fraction of the track actually played, 0..1.
  duration_ratio real not null default 0 check (duration_ratio >= 0 and duration_ratio <= 1),
  -- Which surface served it, so shelf performance can be told from search.
  surface text not null default 'unknown',
  -- Groups events into one listening session for session-level analysis.
  session_id uuid
);

-- The recommender's read is always "this user, recent first, within a window".
create index if not exists music_play_events_user_time_idx
  on public.music_play_events(user_id, occurred_at desc);
create index if not exists music_play_events_user_video_idx
  on public.music_play_events(user_id, video_id, occurred_at desc);

alter table public.music_play_events enable row level security;

drop policy if exists "music_play_events_select_own" on public.music_play_events;
create policy "music_play_events_select_own" on public.music_play_events
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_play_events_insert_own" on public.music_play_events;
create policy "music_play_events_insert_own" on public.music_play_events
  for insert with check ((select auth.uid()) = user_id);

-- Deliberately no UPDATE policy: the stream is immutable. DELETE is allowed so
-- a listener can clear their own history.
drop policy if exists "music_play_events_delete_own" on public.music_play_events;
create policy "music_play_events_delete_own" on public.music_play_events
  for delete using ((select auth.uid()) = user_id);

-- ── Served impressions ──────────────────────────────────────────────────────
-- One row per slot per build. "Shown twelve times, never played" is the single
-- most useful fact the system was missing, and it cannot be derived from plays.
create table if not exists public.music_impressions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  build_id uuid not null,
  video_id text not null,
  shown_at timestamptz not null default now(),
  position integer not null,
  -- Which pool won the slot, so composition is auditable after the fact.
  pool text not null default 'unknown',
  -- Retrieval provenance: which source produced it and at what rank.
  source text not null default 'unknown',
  retrieval_rank integer not null default -1,
  -- Inferred vocal language and the serving score, for the funnel diagnostics.
  language text not null default 'unknown',
  score real not null default 0,
  -- Model/policy version, so a change in behaviour is attributable.
  model_version text not null default 'v1'
);

create index if not exists music_impressions_user_time_idx
  on public.music_impressions(user_id, shown_at desc);
create index if not exists music_impressions_user_video_idx
  on public.music_impressions(user_id, video_id, shown_at desc);
create index if not exists music_impressions_build_idx
  on public.music_impressions(user_id, build_id);

alter table public.music_impressions enable row level security;

drop policy if exists "music_impressions_select_own" on public.music_impressions;
create policy "music_impressions_select_own" on public.music_impressions
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_impressions_insert_own" on public.music_impressions;
create policy "music_impressions_insert_own" on public.music_impressions
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_impressions_delete_own" on public.music_impressions;
create policy "music_impressions_delete_own" on public.music_impressions
  for delete using ((select auth.uid()) = user_id);

-- ── Vocal language labels ───────────────────────────────────────────────────
-- Shared across users: a track's language is a property of the track, not of
-- the listener, so this is readable by any authenticated user and carries no
-- personal data. Confidence is stored because the two consumers need different
-- certainty: balancing a slate tolerates a probable label, training a long-term
-- language target does not.
create table if not exists public.music_track_language (
  video_id text primary key,
  language text not null
    check (language in ('zh', 'ja', 'en', 'ko', 'other', 'instrumental', 'unknown')),
  confidence real not null default 0 check (confidence >= 0 and confidence <= 1),
  -- Which evidence produced it, kept so a label is always inspectable.
  evidence jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.music_track_language enable row level security;

drop policy if exists "music_track_language_select_all" on public.music_track_language;
create policy "music_track_language_select_all" on public.music_track_language
  for select to authenticated using (true);

drop policy if exists "music_track_language_insert_auth" on public.music_track_language;
create policy "music_track_language_insert_auth" on public.music_track_language
  for insert to authenticated with check (true);

drop policy if exists "music_track_language_update_auth" on public.music_track_language;
create policy "music_track_language_update_auth" on public.music_track_language
  for update to authenticated using (true) with check (true);

-- ── Retention ───────────────────────────────────────────────────────────────
-- The longest window the recommender reads is 90 days; impressions are far
-- higher-volume than plays (one row per slot per build). Pruning is a scheduled
-- concern rather than a trigger so a write never pays for it.
create or replace function public.prune_music_exposure(p_days integer default 180)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.music_impressions
   where user_id = (select auth.uid())
     and shown_at < now() - make_interval(days => p_days);
$$;

revoke execute on function public.prune_music_exposure(integer) from anon;
grant execute on function public.prune_music_exposure(integer) to authenticated;
