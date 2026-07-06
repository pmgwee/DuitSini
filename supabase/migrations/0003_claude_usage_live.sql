-- ============================================================================
-- Claude usage live snapshot: pushed by the local Claude Usage Bridge.
-- One row per user; written only by the service role (ingest route), read by
-- the owner via RLS. Stores plan-usage utilization %, never any token.
-- Applied to the live project as migration `claude_usage_live`.
-- ============================================================================

create table if not exists public.claude_usage_live (
  user_id uuid primary key references auth.users(id) on delete cascade,
  five_hour_utilization double precision,
  five_hour_resets_at timestamptz,
  seven_day_utilization double precision,
  seven_day_resets_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.claude_usage_live enable row level security;

-- Owner may read their own snapshot. No insert/update/delete policies exist, so
-- anon/authenticated cannot write — only the service role (which bypasses RLS)
-- writes, from the secret-authenticated ingest route.
drop policy if exists "claude_usage_live_select_own" on public.claude_usage_live;
create policy "claude_usage_live_select_own" on public.claude_usage_live
  for select using ((select auth.uid()) = user_id);
