-- ============================================================================
-- Multi-source live usage: broadcast more than one usage stream per user in a
-- single row (e.g. Claude Pro from a subscription login AND GLM from a
-- cc-switch-routed Claude Code CLI, live at the same time).
--
-- `streams_json` holds an array of stream objects, each:
--   { source, label, five_hour, seven_day, limits, provider, updated_at }
-- The bridge fetches every available source in one cycle and pushes them
-- together (one ingest call → one atomic write, no read-modify-write race).
-- The legacy scalar columns (five_hour_*, seven_day_*, limits_json,
-- provider_json) keep mirroring the PRIMARY stream so older readers/bridges
-- keep working. Additive & idempotent.
-- ============================================================================

alter table public.claude_usage_live
  add column if not exists streams_json jsonb;
