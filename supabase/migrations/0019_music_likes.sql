-- ============================================================================
-- Explicit taste signals: likes, and suppression (not-interested / snooze).
--
-- WHY A SEPARATE TABLE. `music_plays` is keyed on tracks the listener actually
-- started. A like can happen on a track that was never played (tapping the
-- heart on a shelf row), so likes cannot be a column there without inventing
-- phantom play rows. The like carries its own track metadata so the Liked shelf
-- renders without joining anything.
--
-- WHY LIKES MATTER. Per Hu/Koren/Volinsky 2008, an interaction splits into a
-- binary PREFERENCE and a CONFIDENCE level (c = 1 + alpha*r). Once a track has
-- been played at all, preference is already 1 — a like does not raise it, it
-- raises how certain we are that the 1 is real. It is the least ambiguous
-- signal a listener can give us, which is why it dominates the confidence term
-- in `lib/music/ranking.ts`.
--
-- Suppression is the negative counterpart. Spotify ships both a permanent
-- control ("not interested") and a temporary one (Snooze, 30 days); a
-- like-only system is half a feedback loop.
-- ============================================================================

create table if not exists public.music_likes (
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  title text not null,
  channel text not null default '',
  thumbnail text,
  liked_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index if not exists music_likes_recent_idx
  on public.music_likes(user_id, liked_at desc);

alter table public.music_likes enable row level security;

drop policy if exists "music_likes_select_own" on public.music_likes;
create policy "music_likes_select_own" on public.music_likes
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_likes_insert_own" on public.music_likes;
create policy "music_likes_insert_own" on public.music_likes
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_likes_delete_own" on public.music_likes;
create policy "music_likes_delete_own" on public.music_likes
  for delete using ((select auth.uid()) = user_id);

-- Suppression: `until = null` is permanent ("not interested"); a timestamp is a
-- snooze that lapses on its own. One row per track — snoozing something already
-- marked not-interested just refreshes the row.
create table if not exists public.music_suppressions (
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  kind text not null check (kind in ('not_interested', 'snooze')),
  until timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index if not exists music_suppressions_active_idx
  on public.music_suppressions(user_id, until);

alter table public.music_suppressions enable row level security;

drop policy if exists "music_suppressions_select_own" on public.music_suppressions;
create policy "music_suppressions_select_own" on public.music_suppressions
  for select using ((select auth.uid()) = user_id);

drop policy if exists "music_suppressions_insert_own" on public.music_suppressions;
create policy "music_suppressions_insert_own" on public.music_suppressions
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "music_suppressions_update_own" on public.music_suppressions;
create policy "music_suppressions_update_own" on public.music_suppressions
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "music_suppressions_delete_own" on public.music_suppressions;
create policy "music_suppressions_delete_own" on public.music_suppressions
  for delete using ((select auth.uid()) = user_id);
