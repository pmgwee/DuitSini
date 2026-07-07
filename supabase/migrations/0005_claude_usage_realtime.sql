-- ============================================================================
-- Claude usage: on-demand "pull" signal + realtime broadcasting.
--   * pull_requested_at — the widget's "Pull latest" button stamps this; the
--     bridge polls it and fetches immediately when it changes.
--   * realtime publication — so the browser gets row updates instantly (no
--     manual page refresh) when the bridge pushes a new snapshot.
-- Additive & idempotent.
-- ============================================================================

alter table public.claude_usage_live
  add column if not exists pull_requested_at timestamptz;

do $$ begin
  alter publication supabase_realtime add table public.claude_usage_live;
exception when duplicate_object then null; end $$;
