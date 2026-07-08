-- Adds the `news` and `health` subscription categories introduced with the
-- company-based provider catalog (B2C expansion: NYT/Medium/Substack, Calm/
-- Headspace/Strava). Safe to re-run (idempotent). Mirrors the CATEGORIES const
-- in lib/constants.ts and the generated types in lib/supabase/types.ts.
alter type public.subscription_category add value if not exists 'news';
alter type public.subscription_category add value if not exists 'health';
