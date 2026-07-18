-- Adds the `telecom` subscription category for Malaysian telecommunications
-- bills (U Mobile, redONE, CelcomDigi, Maxis). Safe to re-run (idempotent).
-- Mirrors the CATEGORIES const in lib/constants.ts and the generated types in
-- lib/supabase/types.ts. Apply via Supabase MCP `apply_migration` or
-- `supabase db push`, then regenerate lib/supabase/types.ts.
alter type public.subscription_category add value if not exists 'telecom';
