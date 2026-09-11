-- ============================================================================
-- Codex account enrollment and per-device runtime metadata.
--
-- Tokens and credential paths stay on the member's computer. These tables hold
-- only owner-scoped display/identity metadata and sanitized device state.
-- ============================================================================

create table if not exists public.codex_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_key text not null,
  slot text not null check (slot in ('business', 'member')),
  label text not null check (char_length(label) between 1 and 80),
  email text,
  member_id text,
  provider_account_id text,
  workspace_id text,
  workspace_name text,
  plan_type text,
  verified boolean not null default false,
  status text not null default 'needs_sign_in'
    check (status in ('connected', 'needs_sign_in', 'unsupported', 'offline')),
  device_id text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_key)
);

alter table public.codex_accounts enable row level security;
drop policy if exists "codex_accounts_select_own" on public.codex_accounts;
create policy "codex_accounts_select_own" on public.codex_accounts
  for select using ((select auth.uid()) = user_id);
drop policy if exists "codex_accounts_insert_own" on public.codex_accounts;
create policy "codex_accounts_insert_own" on public.codex_accounts
  for insert with check ((select auth.uid()) = user_id);
drop policy if exists "codex_accounts_update_own" on public.codex_accounts;
create policy "codex_accounts_update_own" on public.codex_accounts
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "codex_accounts_delete_own" on public.codex_accounts;
create policy "codex_accounts_delete_own" on public.codex_accounts
  for delete using ((select auth.uid()) = user_id);

create index if not exists codex_accounts_user_slot_idx
  on public.codex_accounts (user_id, slot);

create table if not exists public.codex_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null default 'This computer',
  protocol_version integer not null default 1,
  switch_supported boolean not null default false,
  active_account_key text,
  active_workspace_id text,
  active_workspace_name text,
  active_email text,
  active_observed_at timestamptz,
  heartbeat_at timestamptz,
  generation bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id)
);

alter table public.codex_devices enable row level security;
drop policy if exists "codex_devices_select_own" on public.codex_devices;
create policy "codex_devices_select_own" on public.codex_devices
  for select using ((select auth.uid()) = user_id);
drop policy if exists "codex_devices_insert_own" on public.codex_devices;
create policy "codex_devices_insert_own" on public.codex_devices
  for insert with check ((select auth.uid()) = user_id);
drop policy if exists "codex_devices_update_own" on public.codex_devices;
create policy "codex_devices_update_own" on public.codex_devices
  for update using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "codex_devices_delete_own" on public.codex_devices;
create policy "codex_devices_delete_own" on public.codex_devices
  for delete using ((select auth.uid()) = user_id);

alter table public.claude_usage_live
  add column if not exists device_id text;

-- Account-aware atomic merge. The ingest route first tries this function so two
-- desktop profiles pushing concurrently cannot lose one another's streams.
-- It is service-role-only: the bridge token is resolved by the route, never by
-- trusting a body-supplied user_id from an untrusted caller.
create or replace function public.merge_claude_usage_live(
  p_user_id uuid,
  p_five_hour_utilization double precision,
  p_five_hour_resets_at timestamptz,
  p_seven_day_utilization double precision,
  p_seven_day_resets_at timestamptz,
  p_updated_at timestamptz,
  p_device_id text,
  p_streams_json jsonb,
  p_limits_json jsonb,
  p_provider_json jsonb,
  p_push_seconds integer,
  p_sharer_version text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  previous jsonb := '[]'::jsonb;
  merged jsonb := '[]'::jsonb;
  item jsonb;
  item_key text;
  has_identified_codex boolean := false;
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;
  if jsonb_typeof(coalesce(p_streams_json, '[]'::jsonb)) <> 'array' then
    raise exception 'streams_json must be an array';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select coalesce(streams_json, '[]'::jsonb)
    into previous
    from public.claude_usage_live
   where user_id = p_user_id
   for update;

  select exists (
    select 1 from jsonb_array_elements(p_streams_json) as elements(value)
     where elements.value->>'source' = 'codex' and nullif(elements.value->>'account_key', '') is not null
  ) into has_identified_codex;

  -- Incoming streams win by their composite identity. Keep omitted prior
  -- streams as bounded saved readings; stream-continuity applies the 24-hour
  -- expiry before this function is called. Concurrent additions are retained.
  for item in select elements.value from jsonb_array_elements(p_streams_json) as elements(value) loop
    item_key := coalesce(item->>'source', '') ||
      case when nullif(item->>'account_key', '') is null then '' else ':' || (item->>'account_key') end;
    if not exists (
      select 1 from jsonb_array_elements(merged) as elements(value)
       where coalesce(elements.value->>'source', '') ||
         case when nullif(elements.value->>'account_key', '') is null then '' else ':' || (elements.value->>'account_key') end = item_key
    ) then
      merged := merged || jsonb_build_array(item);
    end if;
  end loop;

  for item in select elements.value from jsonb_array_elements(previous) as elements(value) loop
    item_key := coalesce(item->>'source', '') ||
      case when nullif(item->>'account_key', '') is null then '' else ':' || (item->>'account_key') end;
    if has_identified_codex and item->>'source' = 'codex' and nullif(item->>'account_key', '') is null then
      continue;
    end if;
    if not exists (
      select 1 from jsonb_array_elements(merged) as elements(value)
       where coalesce(elements.value->>'source', '') ||
         case when nullif(elements.value->>'account_key', '') is null then '' else ':' || (elements.value->>'account_key') end = item_key
    ) then
      merged := merged || jsonb_build_array(jsonb_set(jsonb_set(item, '{cached}', 'true'::jsonb, true), '{state}', '"offline"'::jsonb, true));
    end if;
  end loop;

  -- Keep the payload bounded even if a future producer bypasses the route.
  select coalesce(jsonb_agg(value order by ord) filter (where ord <= 6), '[]'::jsonb)
    into merged
    from jsonb_array_elements(merged) with ordinality as elements(value, ord);

  insert into public.claude_usage_live (
    user_id, five_hour_utilization, five_hour_resets_at,
    seven_day_utilization, seven_day_resets_at, updated_at, device_id,
    streams_json, limits_json, provider_json, push_seconds, sharer_version
  ) values (
    p_user_id, p_five_hour_utilization, p_five_hour_resets_at,
    p_seven_day_utilization, p_seven_day_resets_at, p_updated_at, p_device_id,
    merged, p_limits_json, p_provider_json, p_push_seconds, p_sharer_version
  )
  on conflict (user_id) do update set
    five_hour_utilization = excluded.five_hour_utilization,
    five_hour_resets_at = excluded.five_hour_resets_at,
    seven_day_utilization = excluded.seven_day_utilization,
    seven_day_resets_at = excluded.seven_day_resets_at,
    updated_at = excluded.updated_at,
    device_id = excluded.device_id,
    streams_json = excluded.streams_json,
    limits_json = excluded.limits_json,
    provider_json = excluded.provider_json,
    push_seconds = excluded.push_seconds,
    sharer_version = excluded.sharer_version;
end;
$$;

revoke all on function public.merge_claude_usage_live(uuid, double precision, timestamptz, double precision, timestamptz, timestamptz, text, jsonb, jsonb, jsonb, integer, text) from public, anon, authenticated;
grant execute on function public.merge_claude_usage_live(uuid, double precision, timestamptz, double precision, timestamptz, timestamptz, text, jsonb, jsonb, jsonb, integer, text) to service_role;
