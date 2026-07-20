-- ============================================================================
-- Backfill 'telegram' into every subscription's notification_channels.
--
-- WHY: the daily reminder sweep (app/api/cron/reminders) only delivers for
-- subscriptions whose notification_channels includes 'telegram' — the channel
-- gate near the bottom of the sweep:
--   deliverable = imminent.filter(r => sub.notificationChannels.includes("telegram"))
-- The original column default (0001_init.sql) was '{in_app}', so every
-- subscription created BEFORE Telegram became an app-level create-time default
-- (lib/validation/subscription.ts → ["telegram","in_app"]) still holds
-- '{in_app}' and was silently dropped by that gate — even after the owner
-- linked Telegram and set telegram_enabled=true. The connect/toggle/webhook
-- flows never wrote subscriptions, so linking the bot never switched reminders
-- on for those legacy rows.
--
-- Symptom: a sub added before the Telegram integration (e.g. an old iCloud
-- line) produced NO reminders, while newer subs did — and there is no per-sub
-- channel UI to fix it manually.
--
-- There is no per-subscription channel UI, so these arrays were never a
-- deliberate opt-out (same rationale as 0010's offsets backfill). Add 'telegram'
-- to every subscription missing it, and align the column default with the app's
-- create-time default so the gap can't recur for DB-level inserts. Idempotent.
-- ============================================================================

-- (1) Going forward, DB-level inserts get the same channels the app sets.
alter table public.subscriptions
  alter column notification_channels set default '{telegram,in_app}'::notification_channel[];

-- (2) Backfill: append 'telegram' where it isn't already present.
update public.subscriptions
set notification_channels = notification_channels || 'telegram'::notification_channel
where not notification_channels @> '{telegram}'::notification_channel[];
