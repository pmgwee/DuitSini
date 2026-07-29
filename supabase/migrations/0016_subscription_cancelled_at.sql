-- 0016: replace is_paused / is_cancelled booleans with a single `cancelled_at` date
--
-- Why: a bare boolean can't express "stopped AS OF date X". The charge engine
-- derives past months from the CURRENT row, so a cancelled sub was retroactively
-- erased from months where it was actually paid (last month's history vanished,
-- not just this month's). `cancelled_at` bounds the charge series instead:
-- charges with a date < cancelled_at count (history preserved), on/after don't.
--
-- Pause is removed entirely. This app is a tracker — it doesn't talk to the
-- merchant — so pause and cancel were financially identical (both just flipped
-- isActive). One "stopped" state with an effective date is enough, and it stops
-- the two-buttons-that-do-the-same-thing UX confusion at the source.

alter table public.subscriptions
  add column if not exists cancelled_at date;

-- Backfill: any row previously paused OR cancelled is treated as cancelled
-- "now" (the old model never recorded when). This is the least-wrong default —
-- it preserves the full pre-today charge history for those rows (previously
-- erased) and drops future charges, matching the new semantics going forward.
update public.subscriptions
   set cancelled_at = now()::date
 where (is_cancelled or is_paused)
   and cancelled_at is null;

-- The active-subscriptions partial index predicate referenced both booleans;
-- rebuild it on the new single column.
drop index if exists public.subscriptions_active_idx;
create index if not exists subscriptions_active_idx
  on public.subscriptions(user_id) where cancelled_at is null;

alter table public.subscriptions drop column if exists is_paused;
alter table public.subscriptions drop column if exists is_cancelled;
