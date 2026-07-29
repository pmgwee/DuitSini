-- ============================================================================
-- payment_kind: add 'duitnow'.
-- Splits the former "Bank account/Duitnow" kind in two: a plain bank account
-- (standing instructions / auto-debits / loan installments) and DuitNow
-- (PayNet real-time transfer / QR / Autopay) — both draw from a bank, but they
-- are distinct rails a member may want to tag separately.
-- Mirrors 0015_payment_kind_bank_account.sql. Idempotent: ADD VALUE IF NOT
-- EXISTS (safe inside the migration transaction).
-- ============================================================================
alter type public.payment_kind
  add value if not exists 'duitnow';
