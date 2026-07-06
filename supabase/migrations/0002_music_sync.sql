-- ============================================================================
-- Music sync: Google provider tokens + in-app listening history
-- Applied to the live project as migration `music_sync`.
-- ============================================================================

-- google_tokens: Google OAuth refresh/access tokens for YouTube read sync.
-- RLS enabled with NO policies: only the service role may read/write. Tokens
-- must never reach the browser.
create table if not exists public.google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text,
  refresh_token text not null,
  expires_at timestamptz,
  scopes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.google_tokens enable row level security;

drop trigger if exists set_google_tokens_updated_at on public.google_tokens;
create trigger set_google_tokens_updated_at
  before update on public.google_tokens
  for each row execute function public.set_updated_at();

-- music_plays: tracks played inside the app; powers the "Listen again" shelf.
create table if not exists public.music_plays (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  title text not null,
  channel text not null default '',
  thumbnail text,
  play_count integer not null default 1,
  first_played_at timestamptz not null default now(),
  last_played_at timestamptz not null default now(),
  unique (user_id, video_id)
);

create index if not exists music_plays_recent_idx
  on public.music_plays(user_id, last_played_at desc);

alter table public.music_plays enable row level security;

drop policy if exists "music_plays_select_own" on public.music_plays;
create policy "music_plays_select_own" on public.music_plays
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_plays_insert_own" on public.music_plays;
create policy "music_plays_insert_own" on public.music_plays
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_plays_update_own" on public.music_plays;
create policy "music_plays_update_own" on public.music_plays
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Atomic upsert-increment used by the app; runs as the caller so RLS applies.
create or replace function public.log_music_play(
  p_video_id text,
  p_title text,
  p_channel text,
  p_thumbnail text
) returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.music_plays (user_id, video_id, title, channel, thumbnail)
  values (auth.uid(), p_video_id, p_title, coalesce(p_channel, ''), p_thumbnail)
  on conflict (user_id, video_id) do update
    set play_count     = public.music_plays.play_count + 1,
        last_played_at = now(),
        title          = excluded.title,
        channel        = excluded.channel,
        thumbnail      = excluded.thumbnail;
$$;

revoke execute on function public.log_music_play(text, text, text, text) from anon;
grant execute on function public.log_music_play(text, text, text, text) to authenticated;
