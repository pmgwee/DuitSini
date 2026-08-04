-- ============================================================================
-- music_track_tags — LLM-derived, catalog-global tag cache.
--
-- WHY GLOBAL, NOT PER-USER. A track's genre/mood/era is the same for everyone,
-- so this is keyed on video_id alone (no user_id, unlike music_likes). It is a
-- server-managed cache of the constrained-vocabulary tags produced by GLM in
-- `lib/music/tags.ts`, computed once per track and reused forever — so the cost
-- is amortised and never sits on the per-request hot path.
--
-- WHAT IT POWERS. (1) The cold-start similarity prior in `similarity.ts` — two
-- tracks that share no co-occurrence source fall back to tag cosine, faded the
-- instant any behavioural overlap exists. (2) The intent parser for the vibe
-- surface in `vibe.ts`. Neither sends user identity to the model: only public
-- track metadata.
--
-- RLS. Enabled as a default guard. Reads are allowed for any authenticated
-- listener (catalog metadata is not sensitive); writes happen server-side via
-- the service-role client, which bypasses RLS — so no insert/update/delete
-- policy is granted to cookie-scoped clients.
-- ============================================================================

create table if not exists public.music_track_tags (
  video_id text primary key,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.music_track_tags enable row level security;

drop policy if exists "music_track_tags_read" on public.music_track_tags;
create policy "music_track_tags_read" on public.music_track_tags
  for select using ((select auth.uid()) is not null);
