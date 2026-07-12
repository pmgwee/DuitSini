-- ============================================================================
-- Sharer self-reported cadence + version (sharer v6.2).
-- The live route derives its freshness window from the producer's own push
-- cadence (2 cycles + grace) instead of a hardcoded constant — FRESH_MS was
-- 3 min against a 300s default cadence, guaranteeing a live→manual flap on
-- every cycle. sharer_version gives fleet visibility (who runs what script).
-- Both columns are nullable: pushes from older sharers simply leave them
-- empty and the reader assumes the 300s default.
-- ============================================================================

alter table public.claude_usage_live
  add column if not exists push_seconds integer,
  add column if not exists sharer_version text;
