# Phase 5 — WhatsApp Reminders + Production Hardening (Plan v2, DEFERRED)

> **STATUS: DEFERRED by owner decision (2026-07-10).** Telegram already covers
> reminder delivery; Phase 4 is now the Reports module
> (`docs/phase-4-reports-plan.md`). Nothing in this plan is stale — execute it
> as written when WhatsApp is prioritized. Note: the channel-agnostic ops-alert
> helper (D9) may already exist by then, built by the Reports phase.

> **Audience:** the implementing model (Sonnet 5). This is a *plan* — no Phase-4
> code has been written yet. Read `CLAUDE.md` first; all its conventions apply
> (repo switch, civil dates, RLS vs service-role split, `pnpm typecheck` after
> every task, no test runner, pnpm only).
>
> **Standing user constraint: do NOT commit any work.** Leave everything in the
> working tree. The user commits manually.
>
> **v2 scope change vs v1:** this plan now targets **production level, open to
> all public users, scalable mechanism and design** — the way established SaaS
> notification systems are built. It therefore bundles the WhatsApp integration
> with the sweep hardening it rides on (retry ladder, batching, pacing, async
> delivery reconciliation, ops alerting). The WhatsApp transport and the sweep
> refactor touch the same files; doing them apart would mean rework.

---

## 0. Design philosophy & scale envelope (read this first)

The existing Phase-3 architecture is already the industry-standard *skeleton*
for a notification system — the same shape Knock / Courier / Customer.io use:

| Industry pattern | Already in the tree |
| --- | --- |
| Transactional outbox (delivery ledger, status lifecycle, payload snapshot) | `notification_deliveries` |
| Idempotency keys + atomic compare-and-swap claims | `dedupe_key` unique index + `UPDATE … WHERE status='failed'` claims |
| Dumb channel transports behind a registry, never throw | `NotificationProvider` + `REGISTRY` (`lib/notify/`) |
| Derive-at-send-time (no stale pre-scheduled rows) | `deriveDueReminders` over the charge-series engine |
| Digest batching (one message/user/day) | `byDue` grouping in the sweep |
| Signed expiring connect links; always-200 webhooks | `telegram-link.ts`, telegram webhook |

**Do not rebuild any of that.** Phase 4 extends it. What v2 adds is the
*execution-model maturity* around the skeleton:

1. **Per-channel generalization** — the sweep currently hardcodes telegram.
2. **Retry ladder + dead-letter** — bounded attempts with exponential backoff
   instead of "retry every run for 48h".
3. **Batched reads + pagination + time budget** — kill the per-user N+1 so one
   invocation scales to thousands of users and degrades *loudly*, not silently.
4. **Rate-limit awareness** — honor Telegram 429 `retry_after`; classify
   WhatsApp Graph errors retryable vs terminal.
5. **Async delivery reconciliation** — WhatsApp accepts sends synchronously but
   can fail them *asynchronously*; without `statuses[]` reconciliation the
   ledger lies. (This is the single most important production gap.)
6. **Ops alerting** — failures page the operator instead of rotting in a JSON
   summary nobody reads.

**Scale envelope (be honest about it):** this design is a single-invocation
sweep with `maxDuration = 300`. Batched, it comfortably serves **~2,000–3,000
notification-active users/day**. Past that, the `truncated` ops alert (Task 7)
fires and the answer is **Tier 2: queue-based fan-out** (Vercel Queues /
QStash — dispatcher cron enqueues per-user jobs). Tier 2 is explicitly OUT of
scope here, but every Phase-4 decision keeps it a drop-in: the idempotent
ledger means a per-user job that runs twice is a no-op, so the migration later
is mechanical, not architectural.

---

## 1. Research findings that drove the WhatsApp decisions (validated 2026-07-10)

| Question | Answer |
| --- | --- |
| Can WhatsApp send app-generated reminders? | **Yes — officially** via Meta's WhatsApp Business Cloud API. Business-initiated messages must use **pre-approved utility templates**; free-form text only inside a 24h window after the USER messages first. |
| Unofficial libraries (whatsapp-web.js / Baileys)? | **Rejected.** ToS violation; proactive-sender ban rates 15–30%/yr; WhatsApp's "unanswered message tracking" flags exactly a reminder bot's traffic pattern; a Baileys fork had a real supply-chain attack (Dec 2025). **Not even "temporarily for testing".** |
| Cost | Free in dev (Meta test number → 5 pre-registered recipients). Production: utility template ≈ US$0.01–0.02/msg to Malaysia; free within an open 24h service window. |
| Number requirement | A Cloud-API-registered number **cannot** also run the normal WhatsApp app. Production needs a dedicated number (cheap prepaid SIM). **Never the owner's personal number.** |

**D1 — Official WhatsApp Business Cloud API only.** Zero ban risk, real SLA,
and the provider abstraction was built for precisely this.

**D2 — Two-stage rollout; the code is identical in both stages.**
- **Stage A (build + verify, RM 0):** Meta developer app + free test number →
  up to 5 pre-registered recipients. Everything below is built and end-to-end
  verified in Stage A.
- **Stage B (production):** Meta Business verification + dedicated number +
  display-name + template approval on the real WABA. Flipping envs is the only
  "deploy" step; zero code changes.

---

## 2. Current state (verified in the tree)

| Piece | Where | Status |
| --- | --- | --- |
| Provider contract + registry | `lib/notify/types.ts`, `lib/notify/index.ts` | ✅ `whatsapp` already registered |
| WhatsApp stub | `lib/notify/whatsapp.ts` (isConfigured→false, send→skipped) | ✅ replace internals, keep interface |
| `notification_channel` enum incl. `whatsapp` | live DB (`0001_init.sql`) | ✅ no enum change |
| Profile columns | `user_profiles.whatsapp_phone`, `whatsapp_enabled` | ✅ exist; opt-in audit columns still needed (D10) |
| Per-sub channels array | `subscriptions.notification_channels` | ✅ can already hold `whatsapp` |
| Digest sweep | `app/api/cron/reminders/route.ts` — **telegram-hardcoded** (`channel = "telegram"`, telegram-gated profile query, dedupe `${userId}:telegram:digest:${dueISO}`), per-user N+1 subs query, unbounded retry | ⚠️ the core refactor (D5 + D6) |
| HMAC deep-link code helper | `lib/notify/telegram-link.ts` | ✅ generalize (D3) |
| Ledger | `notification_deliveries` (0001) | ⚠️ needs retry/reconciliation columns (D6/D8, migration 0011) |
| Env slots | `.env.example`: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | ✅ declared; more needed (D4) |
| Settings page + cards | `app/(app)/settings/` + `features/settings/` | ✅ WhatsApp card mirrors telegram-card |
| Telegram provider | `lib/notify/telegram.ts` | ⚠️ ignores 429 `retry_after` (D7) |

---

## 3. Architecture decisions

### D3 — Connect flow: wa.me deep link, generalized HMAC code helper
No new tables. Generalize the stateless code helper:
- `lib/notify/link-code.ts` (new): the exact logic of `telegram-link.ts` with
  the secret passed as a parameter (`createLinkCode(userId, secret, now?)`,
  `verifyLinkCode(code, secret, now?)`). Keep the 36-byte
  `userId(16)·exp(4)·mac(16)` base64url format and the 10-min TTL. Keep the
  SECURITY POSTURE comment (not single-use; stateless; leak-within-TTL risk).
- `lib/notify/telegram-link.ts` becomes a thin re-export binding
  `TELEGRAM_WEBHOOK_SECRET` — **behavior byte-identical**, existing telegram
  connect/webhook code untouched.
- `GET /api/integrations/whatsapp/connect` — session + `Sec-Fetch-Site` CSRF
  guard, exactly mirroring `app/api/integrations/telegram/connect/route.ts`.
  Returns `https://wa.me/<WHATSAPP_BOT_NUMBER>?text=CONNECT-<code>` (code keyed
  by `WHATSAPP_WEBHOOK_VERIFY_TOKEN`).
- User taps → WhatsApp opens pre-filled → sends. That user-initiated message is
  simultaneously (a) the account link, (b) Meta-compliant opt-in **which we
  timestamp for audit** (D10), and (c) opens a free 24h service window, so the
  "✅ Connected" reply is free-form text (no template needed).

### D4 — Provider: real Cloud API transport in `lib/notify/whatsapp.ts`
- `send(recipient, payload)` → `POST
  https://graph.facebook.com/<WHATSAPP_GRAPH_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages`
  with `Authorization: Bearer WHATSAPP_ACCESS_TOKEN`.
- **Reminders are business-initiated → always send the approved utility
  template** (`WHATSAPP_TEMPLATE_NAME`, default `subscription_reminders`,
  language `en`). Template body (submitted by the USER in Business Manager,
  documented in the testing guide, never sent as free-form):
  > `⏰ Subscription reminders for {{1}}: {{2}}`
  Category **Utility** (not Marketing — cheaper, and Marketing gets frequency-
  paused).
- **Template params cannot contain newlines.** Extend `NotifyPayload` with
  `templateParams?: string[]`. Add
  `buildDigestTemplateParams(reminders, todayISO, dueISO): [string, string]`
  to `lib/notify/messages.ts` (pure; reuses the line-item wording minus HTML) —
  param 2 is a **semicolon-separated single line**
  ("Netflix renews 13 Jul (RM 54.90); Figma trial converts 11 Jul (RM 71.16)").
  Strip/collapse `\n`/`\t` defensively. Accept that WhatsApp digests are
  plainer than Telegram's.
- Free-form text send (`type: "text"`) is also implemented but used ONLY by the
  webhook replies (inside the user-initiated 24h window) — never by the sweep.
- `isConfigured()` = `WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID`.
  "Dumb transport, never throws" semantics identical to `telegram.ts`.
- **Graph error taxonomy (production requirement).** Parse
  `error.code`/`error.error_subcode` from failure bodies and classify:
  - **Terminal (→ `skipped` with reason, never retried):** `131026` (recipient
    not on WhatsApp / can't receive), `131050`+ policy blocks (user stopped
    marketing), `132001` (template does not exist / not approved), `100` with
    template-param mismatch.
  - **Retryable (→ `failed`, retry ladder picks it up):** `130429` (throughput
    rate limit), `131048`/`131056` (spam/pair rate limits), network errors,
    5xx.
  - **Config-class (→ `failed` + ops alert, D9):** `190` (expired/invalid
    access token — EVERY send is about to fail; the operator must rotate the
    token).
- **Capture `messages[0].id` (the `wamid`)** from the success response and
  return it as `providerMessageId` (new optional field on `NotifyResult`) — the
  sweep stores it for async reconciliation (D8).

### D5 — Per-channel sweep generalization (the core refactor)
`app/api/cron/reminders/route.ts` stops assuming telegram:
- Profile query fetches both channel columns
  (`telegram_chat_id, telegram_enabled, whatsapp_phone, whatsapp_enabled`) for
  any user with at least one channel enabled+linked (fetch broadly, filter in
  JS — simpler than a nested `.or()`).
- Per user, build `channels: { channel: NotificationChannel; recipient: string }[]`
  (telegram → chat_id, whatsapp → phone).
- Per-reminder channel gate stays: sub's `notificationChannels.includes(channel)`.
  Derive reminders ONCE per user, then loop channels: filter per channel →
  `deliverDigest(..., channel, recipient, ...)`.
- Dedupe key becomes `${userId}:${channel}:digest:${dueISO}` — the format is
  already channel-scoped; just parameterize the literal `"telegram"`.
  **Telegram keys must come out byte-identical to today's** — this is what
  prevents a re-send storm on deploy (checklist §8.2).
- `retryFailed`'s disable-gate generalizes:
  `enabled: Map<NotificationChannel, Set<userId>>` instead of one telegram set.
- WhatsApp digest ledger rows store `templateParams` in `payload_json`
  alongside `text` (audit list needs no structural change — the channel column
  already renders).

### D6 — Retry ladder + dead-letter (migration 0011)
Replace "retry anything failed in the last 48h, 10-min floor" with bounded
exponential backoff — the standard outbox retry policy:
- New columns: `attempt_count int not null default 0`,
  `next_retry_at timestamptz` on `notification_deliveries`.
- Ladder: on failure at attempt N (1-based), set
  `next_retry_at = now() + [10m, 1h, 6h, 24h][N-1]`; `MAX_ATTEMPTS = 5`.
- `retryFailed` selects `status='failed' AND attempt_count < 5 AND
  next_retry_at <= now()` (48h outer window kept as a safety bound; the ladder
  sums to ~31h so it fits).
- **Dead-letter is a predicate, not a new enum value:** `status='failed' AND
  attempt_count >= 5`. Do NOT alter the `delivery_status` enum (enum surgery in
  a live DB for zero functional gain). The deliveries list
  (`features/settings/deliveries-list.tsx`) renders "failed (gave up)" when
  `attempt_count >= 5` — read it from `payload_json`-adjacent columns already
  selected.
- The stuck-pending recovery (crash between claim and send) stays, and now also
  increments `attempt_count`.
- Partial index for the retry scan:
  `create index ... on notification_deliveries(next_retry_at) where status = 'failed'`.

### D7 — Rate-limit awareness in providers
- **Telegram:** on 429, parse `parameters.retry_after` from the response body;
  return `{ outcome: "failed", errorMessage, retryAfterSeconds }` (new optional
  `NotifyResult` field). The sweep uses it: `next_retry_at = now() +
  max(retryAfterSeconds, ladder step)`. Telegram's global bot limit is ~30
  msg/s — sequential per-user sends already self-throttle at this scale; no
  artificial pacing loop needed yet (Tier 2's queue gives real smoothing).
- **WhatsApp:** rate-limit codes are classified retryable (D4); the starter
  tier is 250 business-initiated conversations/day (documented in the testing
  guide; auto-scales with quality once verified). No code change beyond the
  taxonomy.

### D8 — Async delivery reconciliation (WhatsApp `statuses[]`)
The Graph API can accept a template send synchronously and fail it minutes
later (quality pauses, tier caps, recipient filters). Without reconciliation
the ledger reports `sent` for messages that never arrived — unacceptable for a
paid public product:
- Sweep stores `provider_message_id` (the `wamid`) on the ledger row when the
  provider returns it (new column, indexed).
- The webhook `POST` handler also processes `entry[].changes[].value.statuses[]`:
  - `status: "failed"` → look up the row by `provider_message_id`; classify
    `errors[0].code` with the D4 taxonomy: retryable → set `status='failed'`
    (+ ladder scheduling) so `retryFailed` re-attempts; terminal → `skipped`
    with the reason.
  - `sent` / `delivered` / `read` → **ignored by design** (read-receipt
    analytics is out of scope; note it in a route comment).
- Telegram needs none of this (its API is synchronous-confirm).

### D9 — Ops alerting (minimum viable production observability)
- New env `OPS_ALERT_TELEGRAM_CHAT_ID` (the owner's own chat id, reuses
  `TELEGRAM_BOT_TOKEN`). New helper `lib/notify/ops-alert.ts`:
  `sendOpsAlert(text)` — fire-and-forget, never throws, no-op when unset.
- The sweep sends ONE compact alert at the end **only when** something needs a
  human: `failed > 0`, the sweep itself threw, the time budget truncated the
  run (D11), or a config-class provider error (Graph `190`) was seen.
  Example: `⚠️ reminders sweep: 3 failed, 1 truncated, users=1204 sent=317 (2026-07-10)`.
- Success is silent. This is the "ops channel" pattern every small SaaS runs
  before graduating to Sentry/PagerDuty (which remain out of scope).

### D10 — Opt-in/opt-out compliance (Meta requirement + audit)
- Inbound webhook keywords (case-insensitive, trimmed):
  - `CONNECT-<code>` → verify HMAC + expiry → service-role upsert
    `whatsapp_phone = messages[].from` (E.164 digits, no `+`),
    `whatsapp_enabled = true`, `whatsapp_opted_in_at = now()` → free-form
    "✅ Connected" reply.
  - `STOP` → `whatsapp_enabled = false`, `whatsapp_opted_out_at = now()` →
    confirm reply. (Meta-required; also honored by the sweep's enabled-gate and
    `retryFailed`'s disable-gate automatically.)
  - `START` → re-enable **only if** a phone is already linked → confirm reply.
  - Anything else → one gentle hint reply ("Manage reminders from your
    dashboard Settings page"), and only inside the free service window (it's a
    reply to a user message, so it always is).
- Audit columns `whatsapp_opted_in_at` / `whatsapp_opted_out_at` on
  `user_profiles` (migration 0011) — Meta can ask for opt-in proof; SaaS
  standard is to store the timestamp, and the wa.me message itself is the
  consent artifact.
- Meta redelivers webhooks on slow/failed responses: every handler above is
  idempotent (upserts / absolute writes), and the route always returns 200
  fast — same retry-storm discipline as the telegram webhook.

### D11 — Sweep scale hardening (kill the N+1, bound the run)
- **Paginate profiles**: stable `order("user_id")` + `.range()` pages of 500.
- **Batch subscriptions**: one query per chunk of ~100 user ids
  (`.in("user_id", chunk)`), grouped in JS — turns N queries into N/100.
- **Time budget**: `maxDuration = 300` (current platform default allows it);
  soft budget ~240s checked between users. On exhaustion: stop cleanly, return
  `{ truncated: n }` in the summary, fire the ops alert (D9). Idempotent dedupe
  keys make the next daily run a safe resume — nothing double-sends, the alert
  tells the operator it's time for Tier 2.
- Per-user derivation stays pure and per-user (it's CPU-trivial); only the I/O
  is batched.

### D12 — Timezone-local delivery hour (GATED — decide before building)
Public users span timezones; `0 2 * * *` (10:00 MYT) is 22:00 in New York.
The SaaS-standard fix: run the cron **hourly**, store `digest_hour int not null
default 9` on `user_profiles`, and each run processes only users whose *local*
hour (via their IANA `timezone`) equals their `digest_hour`. Dedupe keys
already make this double-send-proof.
- **Vercel constraint:** hourly cron requires **Vercel Pro** (Hobby crons run
  once daily at imprecise times).
- **What to build now regardless:** add the `digest_hour` column in migration
  0011 (cheap, forward-compatible) and the local-hour filter behind
  `REMINDERS_HOURLY=1`. If the user stays on Hobby: env unset, filter inactive,
  `vercel.json` keeps `0 2 * * *`, column lies dormant. If Pro: set the env,
  change the schedule to `0 * * * *`. **Ask the user which before Task 7; do
  not silently assume Pro.**

### OUT of scope for Phase 4 (do not build)
Tier-2 queue fan-out (Vercel Queues dispatcher/worker — the documented next
step past ~3k users); delivered/read receipt analytics; media/interactive
messages; multi-language templates; WhatsApp for monthly/yearly reports;
template auto-creation via Graph API (user creates it once in Business Manager);
Sentry/structured APM; email/in_app providers.

---

## 4. Data model — migration `supabase/migrations/0011_phase4_whatsapp_prod.sql`

```sql
-- Retry ladder + async reconciliation (D6, D8)
alter table public.notification_deliveries
  add column if not exists attempt_count int not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists provider_message_id text;

create index if not exists notification_deliveries_retry_idx
  on public.notification_deliveries(next_retry_at)
  where status = 'failed';

create index if not exists notification_deliveries_provider_msg_idx
  on public.notification_deliveries(provider_message_id)
  where provider_message_id is not null;

-- WhatsApp opt-in audit (D10) + timezone-local send hour (D12, dormant on Hobby)
alter table public.user_profiles
  add column if not exists whatsapp_opted_in_at timestamptz,
  add column if not exists whatsapp_opted_out_at timestamptz,
  add column if not exists digest_hour int not null default 9;
```

Apply via Supabase MCP `apply_migration`, then regenerate
`lib/supabase/types.ts` (MCP `generate_typescript_types`). No enum changes. No
RLS changes (all new columns are written by service-role paths or the existing
self-profile policies).

---

## 5. Environment variables (final list; add to `.env.example` with comments)

| Var | Purpose | New? |
| --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | permanent system-user token (Graph API bearer) | exists |
| `WHATSAPP_PHONE_NUMBER_ID` | the sender number's Cloud API id | exists |
| `WHATSAPP_APP_SECRET` | HMAC key for `X-Hub-Signature-256` webhook validation | **new** |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Meta GET-handshake token AND the wa.me connect-code HMAC key | **new** |
| `WHATSAPP_BOT_NUMBER` | E.164 digits of the bot number, builds the `wa.me/<n>` link | **new** |
| `WHATSAPP_TEMPLATE_NAME` | approved utility template (default `subscription_reminders`) | **new, optional** |
| `WHATSAPP_GRAPH_VERSION` | Graph version (default `v24.0`) | **new, optional** |
| `OPS_ALERT_TELEGRAM_CHAT_ID` | owner's chat id for sweep failure alerts (D9) | **new, optional** |
| `REMINDERS_HOURLY` | `1` enables the local-hour filter (D12, Pro only) | **new, optional** |

`WHATSAPP_BUSINESS_ACCOUNT_ID` is NOT needed by runtime code.

---

## 6. Execution order (tasks for the implementer)

Work top-to-bottom; each task ends with `pnpm typecheck` green. **No commits.**
No new npm dependencies — native `fetch` + `node:crypto` only.

| # | Task | Files | Acceptance |
| --- | --- | --- | --- |
| 1 | Migration 0011 + types regen | `supabase/migrations/0011_phase4_whatsapp_prod.sql`, `lib/supabase/types.ts` | §4 SQL applied; regenerated types include the new columns |
| 2 | Generalize link-code helper | `lib/notify/link-code.ts` (new), `lib/notify/telegram-link.ts` (thin re-export) | telegram connect + webhook behavior byte-identical; helper takes the secret as a param; SECURITY POSTURE comment preserved |
| 3 | Contract extensions + telegram 429 | `lib/notify/types.ts` (`templateParams?` on payload; `retryAfterSeconds?`, `providerMessageId?` on result), `lib/notify/telegram.ts` | 429 body's `parameters.retry_after` surfaces on the result; non-429 behavior unchanged |
| 4 | WhatsApp provider (real transport) + template params | `lib/notify/whatsapp.ts`, `lib/notify/messages.ts` (`buildDigestTemplateParams`) | isConfigured gates on both envs; template POST per D4; error taxonomy (terminal→skipped, retryable→failed, 190→failed+flag); `wamid` returned; params newline-stripped; never throws |
| 5 | WhatsApp routes | `app/api/integrations/whatsapp/{webhook,connect,test,toggle}/route.ts` | GET echoes `hub.challenge` on verify-token match else 403; POST validates `X-Hub-Signature-256` over the **raw body** (`req.text()` before parse, `timingSafeEqual`), handles CONNECT/STOP/START (D10) + `statuses[]` (D8), always 200 fast; connect/test/toggle mirror telegram equivalents' session auth + `Sec-Fetch-Site` guard; test route sends the template with fixed params |
| 6 | Sweep refactor A — per-channel | `app/api/cron/reminders/route.ts` | channels loop per D5; dedupe `${userId}:${channel}:digest:${dueISO}` with telegram keys byte-identical; per-channel enabled map in retryFailed; whatsapp rows carry `templateParams`; `provider_message_id` stored; dry-run output includes channel |
| 7 | Sweep refactor B — production hardening | same file, `lib/notify/ops-alert.ts` (new) | pagination + chunked sub fetches (D11); `maxDuration = 300` + 240s soft budget + `truncated` in summary; retry ladder wired to `attempt_count`/`next_retry_at` (D6) incl. `retryAfterSeconds`; ops alert fires on failed>0 / throw / truncation / config-class errors, silent on success (D9); `REMINDERS_HOURLY` local-hour filter (D12 — **ask the user about Vercel Pro first**) |
| 8 | Settings WhatsApp card | `features/settings/whatsapp-card.tsx` (new), `app/(app)/settings/page.tsx`, `app/(app)/settings/loading.tsx` | mirrors telegram-card states (connect → wa.me link in new tab with "send the pre-filled message" hint; connected → masked phone `+60•••1234`, Send test, enable/disable toggle); profile select extended; deliveries list renders "failed (gave up)" at `attempt_count >= 5` |
| 9 | Env + docs | `.env.example` (§5 vars with comments), `docs/phase-4-whatsapp-testing-guide.md` (new) | guide covers: Meta app creation, test number, 5 recipients, webhook subscribe + verify handshake, template submission text, curl smoke tests for webhook GET/POST + sweep dry-run, STOP/START walkthrough, Stage-B production checklist — followable with zero code knowledge |
| 10 | Final verify | — | `pnpm typecheck` + `pnpm build` green; §8 checklist walked with proofs |

---

## 7. Tools the implementer should use

- `pnpm typecheck` per task; `pnpm build` at the end (build flakes on
  page-data collection are known — retry once before investigating).
- Supabase MCP: `apply_migration` (task 1 only), `generate_typescript_types`,
  `execute_sql` for **read-only verification** queries after that.
- Meta Graph runtime surface is exactly one endpoint:
  `POST /<phone_number_id>/messages` (template + text). Everything else
  (app creation, webhook subscription, template submission) is the USER's job
  in Meta dashboards, guided by the testing guide.

---

## 8. Verification checklist (definition of done)

1. `pnpm typecheck` + `pnpm build` pass.
2. **Telegram regression (critical):** with a telegram-only user, dry-run and
   real-run outputs are unchanged from pre-refactor, and the dedupe keys
   generated are byte-identical to the existing rows' format — proven by
   comparing a new key against an existing ledger row via `execute_sql`. No
   re-send storm on deploy.
3. Webhook GET: correct verify token → echoes challenge; wrong → 403.
   Webhook POST: missing/bad `X-Hub-Signature-256` → 200-and-drop (logged);
   valid CONNECT code → profile linked (`whatsapp_phone`, `whatsapp_enabled`,
   `whatsapp_opted_in_at` set) + free-form reply arrives.
4. STOP → `whatsapp_enabled=false` + `whatsapp_opted_out_at` set + confirm
   reply + user excluded from the next dry-run; START re-enables.
5. With a whatsapp-linked recipient and a due reminder: real run sends the
   template digest (semicolon list), ledger row `channel=whatsapp status=sent`
   with `provider_message_id` populated and dedupe key
   `${userId}:whatsapp:digest:<date>`; immediate re-run sends nothing. A user
   with BOTH channels gets exactly two ledger rows for the same due date.
6. Async reconciliation: a `statuses[]` webhook with `status=failed` +
   retryable code flips the row to `failed` with `next_retry_at` set; a
   terminal code flips it to `skipped` with the reason.
7. Retry ladder: a forced failure retries at ~10m (not every run); after 5
   attempts the row stays `failed` with `attempt_count=5` and is never
   re-claimed; deliveries list shows "failed (gave up)".
8. Kill `WHATSAPP_ACCESS_TOKEN` → sweep records `skipped: whatsapp not
   configured`, telegram stream unaffected, route still 200. Set a garbage
   token → Graph `190` classed as config failure and the ops alert fires.
9. Ops alert: sweep with `failed>0` produces exactly one Telegram alert to
   `OPS_ALERT_TELEGRAM_CHAT_ID`; a fully green sweep produces none.
10. Scale smoke: seed ~1k fake profiles in a dry-run branch (or reason through
    query counts): subscriptions queries ≈ users/100, not users; a simulated
    budget exhaustion returns `truncated>0` + alert.

---

## 9. What the USER (owner) must do — not the implementer

| When | What | Notes |
| --- | --- | --- |
| Before Task 5 testing | Create Meta developer app (developers.facebook.com) → add WhatsApp product → note the test number's `WHATSAPP_PHONE_NUMBER_ID`, generate a permanent **system-user token** (`WHATSAPP_ACCESS_TOKEN`), copy App Secret (`WHATSAPP_APP_SECRET`) | ~15 min, free, no business verification for Stage A |
| Same step | Add up to 5 recipient numbers in WhatsApp → API Setup; each confirms via OTP | Stage-A allowlist |
| Same step | Choose `WHATSAPP_WEBHOOK_VERIFY_TOKEN`: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` | also the HMAC key for wa.me connect codes |
| **Before Task 7** | **Decide: Vercel Pro (hourly cron → timezone-local delivery) or Hobby (daily 10:00 MYT for everyone)** | D12; the column ships either way |
| After deploy | Subscribe the webhook in the Meta dashboard: callback `https://<site>/api/integrations/whatsapp/webhook`, the verify token, subscribe to **`messages`** (which also carries `statuses[]`) | Meta fires the GET handshake |
| Before Task 10 | Submit utility template `subscription_reminders` in WhatsApp Manager (body text in the testing guide); approval takes minutes–48h | smoke-test the transport with the pre-approved `hello_world` template meanwhile |
| Production ops | Set `OPS_ALERT_TELEGRAM_CHAT_ID` to your own chat id | your pager |
| **Stage B (later, not blocking)** | Meta Business verification + dedicated prepaid SIM as bot number + display name. **Never your personal number** — Cloud API registration removes it from the normal WhatsApp app | flip envs; zero code changes |

---

## 10. Tier 2 (documented for the future, NOT part of Phase 4)

When the ops alert reports truncation (or ~3k notification-active users):
convert the cron route into a **dispatcher** that pages through users and
enqueues `{ userId }` jobs (Vercel Queues or QStash), and move the per-user
derive→digest→send body into a worker route. The dedupe keys, retry ladder,
and reconciliation built in this phase carry over unchanged — that's why they
are built first.
