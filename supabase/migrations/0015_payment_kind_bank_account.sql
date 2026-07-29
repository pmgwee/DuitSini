-- ============================================================================
-- payment_kind: add 'bank_account'.
-- Covers standing instructions / auto-debits / loan installments pulled
-- directly from a bank account balance — distinct from FPX (one-time
-- e-commerce via the online-banking gateway) and from a card charge.
-- Mirrors the catalog kind added in lib/payment-methods.ts (PAYMENT_KINDS).
-- Idempotent: ADD VALUE IF NOT EXISTS (safe inside the migration transaction).
-- ============================================================================
alter type public.payment_kind
  add value if not exists 'bank_account';
