-- ============================================================================
-- Per-user music player settings (starting with volume). The player loads this
-- on mount so a user's chosen volume survives sessions and devices, and writes
-- it back (debounced) whenever they move the slider. One row per user, owner
-- read/write via RLS.
-- ============================================================================
create table if not exists public.music_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  volume smallint not null default 50 check (volume between 0 and 100),
  updated_at timestamptz not null default now()
);

alter table public.music_settings enable row level security;

-- Owner may read + write only their own row.
drop policy if exists "music_settings_own_all" on public.music_settings;
create policy "music_settings_own_all" on public.music_settings
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
