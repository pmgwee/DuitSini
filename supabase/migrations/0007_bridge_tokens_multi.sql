-- ============================================================================
-- Allow MULTIPLE bridge tokens per user.
--
-- Previously bridge_tokens had PRIMARY KEY (user_id) — one token per user — so
-- every new download/Mac-command minted a token that OVERWROTE the previous
-- one, silently killing any bridge still running the old token (401). Move the
-- primary key to a surrogate `id` and index `user_id`, so a user can hold
-- several valid tokens at once (re-download, a second machine, a Mac command).
-- The mint route caps the count by pruning oldest-first.
--
-- Idempotent: creates the table with the new shape on a fresh DB, and migrates
-- an existing PK(user_id) table in place. Applied to the live project.
-- ============================================================================

create table if not exists public.bridge_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- Migrate a pre-existing PK(user_id) table to a surrogate id PK.
alter table public.bridge_tokens
  add column if not exists id uuid not null default gen_random_uuid();

do $$ begin
  alter table public.bridge_tokens drop constraint if exists bridge_tokens_pkey;
exception when others then null; end $$;

do $$ begin
  alter table public.bridge_tokens add constraint bridge_tokens_pkey primary key (id);
exception when others then null; end $$;

create index if not exists bridge_tokens_user_id_idx on public.bridge_tokens (user_id);
