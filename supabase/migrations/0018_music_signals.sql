-- ============================================================================
-- Music behavioural signals: skips, completions, and per-transition outcomes.
--
-- WHY: the recommender previously had exactly one signal — "this track was
-- started" — which cannot distinguish a song the listener loves from one they
-- killed after four seconds. Both Spotify and Apple Music weight an early skip
-- as their strongest NEGATIVE signal and a completion as the passive positive;
-- without them a ranker can only ever reshuffle play history.
--
-- `music_transitions` is the local-sequential model: it records how a specific
-- A -> B hand-off actually went. Spotify's sequencing work shows listeners skip
-- a track when it jumps too far from the previous one; they detect that with
-- audio features, which are no longer purchasable at any price. Learning it per
-- listener from logged outcomes gets to the same place, just gradually.
-- ============================================================================

alter table public.music_plays
  add column if not exists skip_count integer not null default 0;

alter table public.music_plays
  add column if not exists complete_count integer not null default 0;

-- Record a skip (abandoned inside the first 30s) or a completion.
create or replace function public.log_music_signal(
  p_video_id text,
  p_signal text
) returns void
language sql
security invoker
set search_path = ''
as $$
  update public.music_plays
     set skip_count     = public.music_plays.skip_count
                          + case when p_signal = 'skip' then 1 else 0 end,
         complete_count = public.music_plays.complete_count
                          + case when p_signal = 'complete' then 1 else 0 end
   where user_id = (select auth.uid())
     and video_id = p_video_id;
$$;

revoke execute on function public.log_music_signal(text, text) from anon;
grant execute on function public.log_music_signal(text, text) to authenticated;

-- Per-transition outcomes: did the listener stay with B after A?
create table if not exists public.music_transitions (
  user_id uuid not null references auth.users(id) on delete cascade,
  from_video_id text not null,
  to_video_id text not null,
  skips integer not null default 0,
  completions integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, from_video_id, to_video_id)
);

create index if not exists music_transitions_from_idx
  on public.music_transitions(user_id, from_video_id);

alter table public.music_transitions enable row level security;

drop policy if exists "music_transitions_select_own" on public.music_transitions;
create policy "music_transitions_select_own" on public.music_transitions
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_transitions_insert_own" on public.music_transitions;
create policy "music_transitions_insert_own" on public.music_transitions
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_transitions_update_own" on public.music_transitions;
create policy "music_transitions_update_own" on public.music_transitions
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Atomic upsert-increment for a transition outcome; runs as the caller (RLS).
create or replace function public.log_music_transition(
  p_from_video_id text,
  p_to_video_id text,
  p_signal text
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.music_transitions (user_id, from_video_id, to_video_id, skips, completions)
  values (
    (select auth.uid()),
    p_from_video_id,
    p_to_video_id,
    case when p_signal = 'skip' then 1 else 0 end,
    case when p_signal = 'complete' then 1 else 0 end
  )
  on conflict (user_id, from_video_id, to_video_id) do update
    set skips       = public.music_transitions.skips
                      + case when p_signal = 'skip' then 1 else 0 end,
        completions = public.music_transitions.completions
                      + case when p_signal = 'complete' then 1 else 0 end,
        updated_at  = now();
$$;

revoke execute on function public.log_music_transition(text, text, text) from anon;
grant execute on function public.log_music_transition(text, text, text) to authenticated;
