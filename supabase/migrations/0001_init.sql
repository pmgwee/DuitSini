-- ============================================================================
-- Subscription Agent — initial schema, RLS, and triggers
-- Target: Supabase Postgres (auth schema available).
-- Safe to re-run: guards on types, tables, policies, and triggers.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type subscription_category as enum
    ('streaming','utilities','saas','ai','music','gaming','productivity','finance','education','cloud','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type billing_cycle as enum
    ('weekly','monthly','quarterly','semiannual','annual','custom_days','custom_months','one_off');
exception when duplicate_object then null; end $$;

do $$ begin
  create type notification_channel as enum ('telegram','whatsapp','email','in_app');
exception when duplicate_object then null; end $$;

do $$ begin
  create type delivery_status as enum ('pending','sent','failed','skipped');
exception when duplicate_object then null; end $$;

do $$ begin
  create type usage_state as enum ('light','medium','heavy');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- user_profiles
-- ---------------------------------------------------------------------------
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  timezone text not null default 'UTC',
  preferred_currency text not null default 'USD',
  theme text not null default 'dark',
  telegram_chat_id text,
  telegram_enabled boolean not null default false,
  whatsapp_phone text,
  whatsapp_enabled boolean not null default false,
  monthly_report_enabled boolean not null default true,
  yearly_report_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  provider text,
  category subscription_category not null default 'other',
  amount numeric(12,2) not null default 0,
  currency text not null default 'USD',
  billing_cycle billing_cycle not null default 'monthly',
  interval_count integer not null default 1 check (interval_count >= 1),
  plan_type text,
  start_date date not null,
  next_renewal_at timestamptz,
  free_trial_end_at date,
  is_trial boolean not null default false,
  is_paused boolean not null default false,
  is_cancelled boolean not null default false,
  unsubscribe_url text,
  icon_type text not null default 'monogram',
  icon_url text,
  color text,
  notes text,
  reminder_offsets_days integer[] not null default '{7,3,1}',
  reminder_time_local text not null default '09:00',
  notification_channels notification_channel[] not null default '{in_app}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);
create index if not exists subscriptions_next_renewal_idx on public.subscriptions(next_renewal_at);
create index if not exists subscriptions_active_idx
  on public.subscriptions(user_id) where not is_cancelled and not is_paused;

-- ---------------------------------------------------------------------------
-- subscription_notifications (per-offset / per-channel overrides)
-- ---------------------------------------------------------------------------
create table if not exists public.subscription_notifications (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  channel notification_channel not null,
  reminder_offset_days integer not null,
  reminder_time_local text not null default '09:00',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscription_notifications_sub_idx
  on public.subscription_notifications(subscription_id);

-- ---------------------------------------------------------------------------
-- notification_deliveries (audit log + dedupe)
-- ---------------------------------------------------------------------------
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  channel notification_channel not null,
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  status delivery_status not null default 'pending',
  error_message text,
  payload_json jsonb,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create unique index if not exists notification_deliveries_dedupe_idx
  on public.notification_deliveries(dedupe_key) where dedupe_key is not null;
create index if not exists notification_deliveries_user_idx
  on public.notification_deliveries(user_id);

-- ---------------------------------------------------------------------------
-- monthly_reports / yearly_reports
-- ---------------------------------------------------------------------------
create table if not exists public.monthly_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  month_key text not null,
  report_html text,
  report_pdf_url text,
  totals_json jsonb,
  delivered_channels_json jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, month_key)
);

create table if not exists public.yearly_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  year_key text not null,
  report_html text,
  report_pdf_url text,
  totals_json jsonb,
  delivered_channels_json jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, year_key)
);

-- ---------------------------------------------------------------------------
-- claude_usage_sessions
-- ---------------------------------------------------------------------------
create table if not exists public.claude_usage_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_started_at timestamptz not null default now(),
  session_ends_at timestamptz not null,
  weekly_window_started_at timestamptz,
  weekly_window_ends_at timestamptz,
  usage_state usage_state not null default 'light',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists claude_usage_user_idx on public.claude_usage_sessions(user_id);

-- ---------------------------------------------------------------------------
-- music_presence (one row per user/source)
-- ---------------------------------------------------------------------------
create table if not exists public.music_presence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'youtube_music',
  track_title text,
  artist_name text,
  album_name text,
  album_art_url text,
  is_playing boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (user_id, source)
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists set_user_profiles_updated on public.user_profiles;
create trigger set_user_profiles_updated before update on public.user_profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_subscriptions_updated on public.subscriptions;
create trigger set_subscriptions_updated before update on public.subscriptions
  for each row execute function public.set_updated_at();

drop trigger if exists set_subscription_notifications_updated on public.subscription_notifications;
create trigger set_subscription_notifications_updated before update on public.subscription_notifications
  for each row execute function public.set_updated_at();

drop trigger if exists set_claude_usage_updated on public.claude_usage_sessions;
create trigger set_claude_usage_updated before update on public.claude_usage_sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — owner-only access to every table
-- ---------------------------------------------------------------------------
alter table public.user_profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.monthly_reports enable row level security;
alter table public.yearly_reports enable row level security;
alter table public.claude_usage_sessions enable row level security;
alter table public.music_presence enable row level security;

drop policy if exists "own profile" on public.user_profiles;
create policy "own profile" on public.user_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subscriptions" on public.subscriptions;
create policy "own subscriptions" on public.subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own subscription notifications" on public.subscription_notifications;
create policy "own subscription notifications" on public.subscription_notifications
  for all using (
    exists (select 1 from public.subscriptions s
            where s.id = subscription_id and s.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.subscriptions s
            where s.id = subscription_id and s.user_id = auth.uid())
  );

drop policy if exists "own deliveries" on public.notification_deliveries;
create policy "own deliveries" on public.notification_deliveries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own monthly reports" on public.monthly_reports;
create policy "own monthly reports" on public.monthly_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own yearly reports" on public.yearly_reports;
create policy "own yearly reports" on public.yearly_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own claude usage" on public.claude_usage_sessions;
create policy "own claude usage" on public.claude_usage_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own music presence" on public.music_presence;
create policy "own music presence" on public.music_presence
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Auto-provision a profile row on signup
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.user_profiles (user_id, full_name)
  values (new.id, new.raw_user_meta_data ->> 'full_name')
  on conflict (user_id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
