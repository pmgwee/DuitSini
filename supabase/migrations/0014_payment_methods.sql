-- ============================================================================
-- Payment methods — reusable instruments (cards / FPX / e-wallets / other).
-- A user owns a small fixed set; subscriptions reference one via nullable FK
-- `subscriptions.payment_method_id`. Catalog slugs (issuer / network) live in
-- the TS constant `lib/payment-methods.ts`; the DB stores the slug strings.
-- Mirrors the conventions of 0001_init.sql (idempotent DDL, gen_random_uuid,
-- owner-only RLS, set_updated_at trigger).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enum: payment_kind
-- ---------------------------------------------------------------------------
do $$ begin
  create type payment_kind as enum
    ('credit_card','debit_card','fpx','e_wallet','other');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- payment_methods
-- ---------------------------------------------------------------------------
create table if not exists public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        payment_kind not null,
  issuer_slug text,                           -- catalog slug (lib/payment-methods.ts); null for free-text
  issuer_name text not null,                  -- denormalized display name
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists payment_methods_user_id_idx
  on public.payment_methods(user_id);

-- Soft dedupe: prevent the same user adding the identical method twice.
create unique index if not exists payment_methods_user_kind_issuer_idx
  on public.payment_methods(user_id, kind, coalesce(issuer_slug,''), issuer_name);

-- ---------------------------------------------------------------------------
-- subscriptions.payment_method_id (nullable; existing rows backfill to NULL)
-- ---------------------------------------------------------------------------
alter table public.subscriptions
  add column if not exists payment_method_id uuid
    references public.payment_methods(id) on delete set null;

create index if not exists subscriptions_payment_method_id_idx
  on public.subscriptions(payment_method_id);

-- ---------------------------------------------------------------------------
-- updated_at trigger (mirrors subscriptions)
-- ---------------------------------------------------------------------------
drop trigger if exists set_payment_methods_updated on public.payment_methods;
create trigger set_payment_methods_updated before update on public.payment_methods
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — owner-only (same model as subscriptions)
-- ---------------------------------------------------------------------------
alter table public.payment_methods enable row level security;

drop policy if exists "own payment methods" on public.payment_methods;
create policy "own payment methods" on public.payment_methods
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Cross-user ownership guard on subscriptions.payment_method_id.
-- RLS on payment_methods alone does NOT stop a user from LINKING another user's
-- method id (UUIDs are guessable enough to not rely on secrecy); this trigger
-- rejects any subscription whose payment_method_id belongs to a different user.
-- ---------------------------------------------------------------------------
create or replace function public.assert_payment_method_owner()
returns trigger as $$
begin
  if new.payment_method_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.payment_methods pm
    where pm.id = new.payment_method_id
      and pm.user_id = new.user_id
  ) then
    raise exception 'payment_method_id % does not belong to user %',
      new.payment_method_id, new.user_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists subscriptions_payment_method_owner on public.subscriptions;
create trigger subscriptions_payment_method_owner
  before insert or update of payment_method_id, user_id on public.subscriptions
  for each row execute function public.assert_payment_method_owner();
