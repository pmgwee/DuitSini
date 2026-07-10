-- ============================================================================
-- Global reminder preferences + per-sub override.
--
-- (a) Add a per-user DEFAULT reminder schedule. The Settings "Default reminder
--     schedule" card writes this; the daily digest sweep uses it for every
--     subscription whose own offsets are NULL ("use my default").
-- (b) Make the per-sub reminder_offsets_days an OPTIONAL override (drop NOT NULL
--     and the DEFAULT), so a subscription can be NULL = inherit the global.
-- (c) Backfill: rows still holding the old default '{7,3,1}' were never
--     deliberately chosen (only renewals ever held it) → set to NULL so the
--     global schedule takes effect for them. KEEP non-default values (e.g. trial
--     '{3,1,0}', real customizations) as explicit overrides.
-- ============================================================================

alter table public.user_profiles
  add column if not exists reminder_offsets_days int[] not null default '{7,3,1}';

alter table public.subscriptions
  alter column reminder_offsets_days drop default;
alter table public.subscriptions
  alter column reminder_offsets_days drop not null;

update public.subscriptions
  set reminder_offsets_days = null
  where reminder_offsets_days = '{7,3,1}';
