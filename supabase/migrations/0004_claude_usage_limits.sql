-- ============================================================================
-- Claude usage: store the structured `limits` array (session + per-model weekly
-- windows) pushed by the bridge, so the widget can mirror claude.ai's panel
-- (Current session / All models / Fable / …). Additive & idempotent.
-- ============================================================================

alter table public.claude_usage_live
  add column if not exists limits_json jsonb;
