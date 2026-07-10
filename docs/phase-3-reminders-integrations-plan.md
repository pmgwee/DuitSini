# Phase 3 — Reminders Engine + Messaging Integrations (Implementation Plan)

> **Audience:** the implementing model (Sonnet 5). This is a *plan*, written by the
> advisor pass — no Phase-3 code has been written yet. Read CLAUDE.md first; its
> conventions (MYR-home money, civil dates via `parseISODate`, repo-switch via
> `getSubscriptionRepository()`, RLS vs service-role split) all apply here.
>
> **Standing user constraint: do NOT commit any work.** Leave everything in the
> working tree. The user commits manually.

---

## 1. Current state (verified 2026-07-09)

Already in place — do not rebuild:

| Piece | Where | Status |
| --- | --- | --- |
| Renewal/charge-series engine | `lib/domain/renewal.ts`, `subscription.ts` (`chargeDatesInRange`, `getNextChargeDate`, `isActive`) | ✅ done, pure, reuse as-is |
| Reminder prefs on each sub | `subscriptions.reminder_offsets_days int[]`, `reminder_time_local`, `notification_channels notification_channel[]` | ✅ schema + form already collect them |
| Channel/status enums | `notification_channel` = telegram/whatsapp/email/in_app; `delivery_status` = pending/sent/failed/skipped | ✅ live |
| Delivery ledger table | `notification_deliveries` (user_id, subscription_id, channel, scheduled_for, sent_at, status, error_message, payload_json, **dedupe_key**) | ✅ table live, **unused so far** |
| Per-user integration fields | `user_profiles`: `telegram_chat_id`, `telegram_enabled`, `whatsapp_*`, `timezone` | ✅ live |
| Env slots | `.env.example`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `WHATSAPP_*` | ✅ declared, values empty |
| Reports page (in-app) | `app/(app)/reports/page.tsx` | ✅ done (delivery-to-channel is **not** Phase 3) |
| Live-DB migrations | all through `claude_usage_streams` **+ `music_settings` (applied 2026-07-09)** | ✅ in sync with `lib/supabase/types.ts` |

Leftovers found in the advisor review — resolved or noted:
- `0009_music_settings.sql` was pending on live DB → **applied** (2026-07-09). Nothing else pending.
- `subscription_notifications` table exists but the per-sub arrays on `subscriptions` are the source the UI actually writes. **Decision: ignore the table for Phase 3** (use the arrays); revisit only if per-channel-per-offset overrides become a real feature.
- Working tree has uncommitted CLAUDE.md / README.md / docs/ changes — leave them; user commits manually.

---

## 2. Architecture decisions (read before coding)

### D1 — Derive, don't store (the core idea)
Do **not** build a job queue of future reminders. Every cron run *derives* what is
due right now from current subscription state via the existing charge-series
engine, then records the send in `notification_deliveries` with a deterministic
`dedupe_key`. Consequences, all free of extra machinery:
- Renewal date changed → next run derives from the new date. No reschedule logic.
- Paused/cancelled → `isActive` filters it out at derive time. No cancel logic.
- Missed/duplicate cron runs → the unique dedupe key makes sends idempotent.

**Dedupe key format (canonical):** `${subscriptionId}:${channel}:${offsetDays}:${chargeISO}`
(`trial` as the offset marker for trial-end reminders, e.g. `abc123:telegram:trial:2026-07-15`).
Requires a **unique index** on `notification_deliveries.dedupe_key` — check live schema;
if it's a plain column, add one migration: `create unique index ... where dedupe_key is not null`.

### D2 — Reminder semantics
For each active sub and each `reminder_offsets_days` entry N: a reminder is *due*
on civil date `chargeISO − N days` in the **user's timezone** (`user_profiles.timezone`,
fall back `Asia/Kuala_Lumpur`). Trial subs: the **trial-end date is the charge that
matters** — remind at the same offsets against `freeTrialEndAt`, labelled "trial
converts", and skip the ordinary renewal reminder for the same date (blueprint:
trial-end takes priority). Look ahead `max(offsets) + 1` days; also send anything
whose due-date was **yesterday** (one-day catch-up window for a missed cron run),
never older.ph

### D3 — Scheduler = Vercel Cron hitting a protected route
`vercel.json` → `{ "crons": [{ "path": "/api/cron/reminders", "schedule": "0 2 * * *" }] }`
(02:00 UTC = 10:00 MYT — morning delivery for the MYR-home user base).
- Route checks `Authorization: Bearer ${CRON_SECRET}` (Vercel injects it when the
  env var exists). 401 otherwise. Also accept `?dry=1` (compute + return JSON,
  no sends, no ledger writes) for verification.
- **Known limitation to document, not solve:** Hobby-plan cron is once daily, so
  `reminder_time_local` precision can't be honored yet — everything due "today"
  goes out in the morning batch. Upgrade paths (Pro per-minute cron, or an
  external pinger) are a later phase; the route is already windowed/idempotent
  so nothing changes except the schedule line.
- The route uses the **service role** (`createSupabaseAdminClient`) — it has no
  user cookie and must sweep all users. Same trust pattern as the bridge ingest.
  Keep `maxDuration = 60`, wrap the whole handler in try/catch → structured JSON
  (the bridge's HTML-500 lesson).

### D4 — Provider abstraction (Telegram first, WhatsApp pluggable)
```
lib/notify/types.ts     → NotifyPayload (text-first), NotifyResult, NotificationProvider
lib/notify/telegram.ts  → implements provider via Bot API sendMessage (parse_mode: "HTML")
lib/notify/whatsapp.ts  → stub: isConfigured() false → result "skipped: not configured"
lib/notify/index.ts     → getProvider(channel) registry; unknown/email/in_app → skipped
```
Rules: providers are dumb transports (no DB access); HTML parse mode (escape only
`& < >` — far simpler than MarkdownV2); a failed provider send records status
`failed` + `error_message` in the ledger and **never throws past the per-delivery
loop** (one user's bad chat_id must not kill the whole run). Retry = next cron
run re-attempts `failed` rows scheduled within the last 48h (update in place; the
dedupe row already exists, so use update-not-insert for retries).

### D5 — Telegram connect flow (no new table)
Deep-link + webhook, with a **stateless HMAC link code** so no migration is needed:
- `GET /api/integrations/telegram/connect` (session-cookie authed, same
  `Sec-Fetch-Site` CSRF guard as `mint-token.ts`) → returns
  `https://t.me/<BOT_USERNAME>?start=<code>` where
  `code = base64url(userId.expiresAt.hmacSHA256(userId + expiresAt, TELEGRAM_WEBHOOK_SECRET))`,
  15-minute expiry. **Telegram start-payload constraint: ≤64 chars, `[A-Za-z0-9_-]` only**
  — truncate the HMAC to 16 bytes and strip padding; verify with `timingSafeEqual`.
- `POST /api/integrations/telegram/webhook` — validate header
  `x-telegram-bot-api-secret-token === TELEGRAM_WEBHOOK_SECRET` (reject 401), parse
  `/start <code>`, verify HMAC + expiry, then service-role upsert
  `user_profiles.telegram_chat_id = message.chat.id`, `telegram_enabled = true`,
  and reply via sendMessage ("✅ Connected — you'll get renewal reminders here").
  Always return 200 `{ok:true}` to Telegram even on bad codes (reply with a
  friendly error instead) so Telegram doesn't retry-storm the route.
- `POST /api/integrations/telegram/test` (session-authed) → sends "Test message"
  to the caller's own chat_id; surfaces the provider error verbatim on failure.
- Env additions: `TELEGRAM_BOT_USERNAME` (for the deep link), `CRON_SECRET` —
  add both to `.env.example`.

### D6 — Message content
One reminder message per due (sub × charge × offset), per enabled channel:
`⏰ <b>Netflix</b> renews in 3 days — Tue 15 Jul · RM 54.90 (USD 11.99)` +
trial variant `⚠️ <b>Figma</b> trial converts in 1 day …` + `unsubscribe_url`
line when present. Amounts: original currency + MYR equivalent via `toMYR`
(round once, existing formatters). Dates: existing `formatLongDate` (en-GB,
deterministic). Channel gate: sub's `notification_channels` **and** the profile
toggle (`telegram_enabled` + chat_id present) must both pass; otherwise record
`skipped` with a reason — the ledger doubles as the audit log.

---

## 3. Execution order (tasks for the implementer)

Work top-to-bottom; each task ends with `pnpm typecheck` green. **No commits.**

| # | Task | Files | Acceptance |
| --- | --- | --- | --- |
| 0 | ~~Verify `dedupe_key` uniqueness~~ — **confirmed already live**: `notification_deliveries_dedupe_idx` is a unique partial index (`WHERE dedupe_key IS NOT NULL`), verified via `execute_sql` on 2026-07-09. No migration needed. | — | done |
| 1 | Provider contract + registry + Telegram provider + WhatsApp stub | `lib/notify/{types,telegram,whatsapp,index}.ts` | pure transports; telegram `isConfigured()` gates on env; HTML escaping helper unit-safe |
| 2 | Reminder derivation (pure domain) | `lib/reminders/engine.ts` | given (subs, timezone, todayISO) → `DueReminder[]` with dedupe keys; trial-priority + catch-up rules from D2; **no I/O, no `new Date()` inside** — caller passes today |
| 3 | Cron sweep route | `app/api/cron/reminders/route.ts` | CRON_SECRET auth; `?dry=1`; per-user sweep via service role; insert-ledger → send → update status; retries failed <48h; returns `{users, derived, sent, skipped, failed}` JSON; try/catch whole body |
| 4 | Cron schedule + env docs | `vercel.json` (new), `.env.example` (+`CRON_SECRET`, `TELEGRAM_BOT_USERNAME`) | daily 02:00 UTC (10:00 MYT) entry |
| 5 | Telegram connect + webhook + test routes | `app/api/integrations/telegram/{connect,webhook,test}/route.ts`, `lib/notify/telegram-link.ts` | flow per D5; webhook always 200; HMAC timing-safe |
| 6 | Settings surface | `app/(app)/settings/page.tsx` + `features/settings/telegram-card.tsx` (+ loading.tsx) | Connect button (deep link opens Telegram), live status (connected as chat_id present), Test-message button, enable/disable toggle writing `telegram_enabled`; add Settings to sidebar + mobile nav in `components/layout/app-shell.tsx` |
| 7 | Recent-deliveries list on settings page | reuse ledger query (RLS server component) | last 10 deliveries with status chips — the "reminder sent success / failed delivery" states from the blueprint |

Out of scope for Phase 3 (do not build): WhatsApp real transport (stub only),
report delivery to channels, email/in-app channels, per-sub `subscription_notifications`
overrides, honoring `reminder_time_local` exactly (cron granularity — documented).

## 4. Tools the implementer should use

- `pnpm typecheck` after every task (no test runner exists — don't add one).
- Supabase MCP `apply_migration` + `generate_typescript_types` **only if** task 0
  needs the unique index (schema change → regenerate types, per CLAUDE.md).
- `NEXT_PUBLIC_DATA_SOURCE=mock` + `?dry=1` for local engine verification without
  Supabase or a bot token (the cron route itself requires supabase mode; the pure
  engine in task 2 can be exercised via the dry-run JSON output on dev against mock data too — if mock mode is active, sweep just the demo user).
- Telegram Bot API docs endpoints used: `sendMessage`, `setWebhook` (setWebhook is
  run manually by the user, not in code — document the one-liner in the settings card or README).

## 5. Env / secrets — what the USER must provide (and when)

Nothing is needed to *implement*. Needed to *verify end-to-end*:

| Var | Where to get it | Needed for |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | @BotFather → /newbot (user does this; ~2 min) | any real send |
| `TELEGRAM_BOT_USERNAME` | same BotFather step | connect deep link |
| `TELEGRAM_WEBHOOK_SECRET` | generate: `openssl rand -hex 24` | webhook auth + link-code HMAC |
| `CRON_SECRET` | generate: `openssl rand -hex 24` | cron route auth |
| One-time after deploy | `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<site>/api/integrations/telegram/webhook&secret_token=<WEBHOOK_SECRET>"` | activate webhook |

Set all four in Vercel env (+ `.env.local` for dev). Webhook testing needs a
public URL — verify on a Vercel preview deploy rather than fighting tunnels.

## 6. Verification checklist (definition of done)

1. `pnpm typecheck` + `pnpm build` pass.
2. `GET /api/cron/reminders?dry=1` with correct bearer → JSON listing derived reminders for a seeded sub with a renewal 3 days out; wrong/no bearer → 401.
3. Real run inserts ledger rows once; immediate re-run sends nothing (dedupe proof — include both run summaries).
4. Pause a sub → next dry-run no longer derives its reminders (D1 proof).
5. Telegram: connect flow stores chat_id; test button delivers; kill the token → ledger records `failed` with the API error, run summary still 200.
6. Settings page renders in mock mode without Supabase (graceful empty states).
