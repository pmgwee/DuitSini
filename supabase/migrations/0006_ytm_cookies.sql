-- ============================================================================
-- ytm_cookies: per-user YouTube Music session cookies for the optional
-- "Listen Again" recommendation shelf.
--
-- WHY: Google removed OAuth from YouTube Music (Nov 2024), so the algorithmic
-- home shelves (Listen Again, Quick Picks, …) can only be read by replaying an
-- authenticated browser session — i.e. the user's YT Music cookies. This is an
-- OPT-IN power-user feature; users who never connect see only the local
-- recency-based shelf.
--
-- SECURITY: these cookies grant full Google-account access (more sensitive than
-- the OAuth refresh tokens in google_tokens). Like google_tokens, this table is
-- RLS-enabled with NO policies, so it is invisible to every client except the
-- service role. Treat as a high-value secret; future hardening = encrypt at rest.
-- ============================================================================

create table if not exists public.ytm_cookies (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- The raw value of the browser `Cookie:` header on a music.youtube.com
  -- request (e.g. "SAPISID=…; __Secure-3PAPISID=…; …"). youtubei.js replays it
  -- verbatim to impersonate the logged-in YT Music session.
  cookie_header text not null,
  -- Best-effort signal when the cookies last produced a successful fetch, so
  -- the UI can hint "may be stale" / prompt re-capture. Null until first hit.
  last_ok_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.ytm_cookies enable row level security;

drop trigger if exists set_ytm_cookies_updated_at on public.ytm_cookies;
create trigger set_ytm_cookies_updated_at
  before update on public.ytm_cookies
  for each row execute function public.set_updated_at();
