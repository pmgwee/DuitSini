# Phase 3 — Reminders & Telegram: Testing Guide

Step-by-step verification of the reminders engine + Telegram integration.
Each test says **what to do**, the **command**, the **expected result**, and
**which plan acceptance criterion (§6) it proves**.

> Windows notes: commands are PowerShell. `curl.exe` is the real curl (not the
> `Invoke-WebRequest` alias). In Git Bash, drop `.exe` and use `$VAR` directly.

---

## 0. Prerequisites & environment

### 0.1 Generate two secrets
```powershell
# Run once; reuse the outputs below.
openssl rand -hex 24   # -> CRON_SECRET
openssl rand -hex 24   # -> TELEGRAM_WEBHOOK_SECRET
```

### 0.2 Create the Telegram bot (~2 min)
1. Open Telegram, message **@BotFather** → `/newbot`.
2. Pick a name + username (e.g. `mysubs_reminders_bot`). Note:
   - **`TELEGRAM_BOT_TOKEN`** — the token BotFather prints.
   - **`TELEGRAM_BOT_USERNAME`** — the username *without* the leading `@`.

### 0.3 Local `.env.local` (for Layers 1–2)
You need **Supabase mode** — the cron route sweeps the real DB:
```env
NEXT_PUBLIC_DATA_SOURCE=supabase
NEXT_PUBLIC_SUPABASE_URL=...           # already set for the app
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...          # the cron route needs this
TELEGRAM_BOT_TOKEN=...                 # only needed to actually send
TELEGRAM_BOT_USERNAME=mysubs_reminders_bot
TELEGRAM_WEBHOOK_SECRET=<from 0.1>
CRON_SECRET=<from 0.1>
```
> The cron route uses the **service role**, so `SUPABASE_SERVICE_ROLE_KEY` is
> required locally. Without it the route returns `503 server not configured`.

### 0.4 Get your user id (for seeding in Layer 2)
Supabase Dashboard → **Authentication → Users** → copy your user's `id` (a UUID).
We'll call it `<YOUR_USER_ID>` below.

---

## Layer 1 — Local smoke: auth + structured JSON (no seed, no Telegram)

Start the dev server:
```powershell
pnpm dev
```

### Test 1.1 — missing/wrong bearer → 401  *(proves auth, §6.2)*
```powershell
curl.exe -s -i "http://localhost:3000/api/cron/reminders?dry=1"
# Expect: HTTP/1.1 401 Unauthorized  {"ok":false,"error":"unauthorized"}
```

### Test 1.2 — correct bearer → 200 JSON  *(proves route wiring + shape)*
```powershell
$h = @{ Authorization = "Bearer $env:CRON_SECRET" }   # set $env:CRON_SECRET first
Invoke-RestMethod -Headers $h "http://localhost:3000/api/cron/reminders?dry=1"
```
Expected (no Telegram-enabled users yet):
```json
{ "ok": true, "dry": true, "users": 0, "derived": 0, "sent": 0, "skipped": 0, "failed": 0, "retriesAttempted": 0, "reminders": [] }
```
If you get `503 server not configured` → `SUPABASE_SERVICE_ROLE_KEY` is missing.

---

## Layer 2 — Local derivation proof (the core logic)

This is the most important layer — it proves the **engine, idempotency, and
pause-filter** without deploying anything. Run this SQL in the Supabase
Dashboard **SQL Editor** (replace `<YOUR_USER_ID>`):

```sql
-- (a) Enable Telegram on YOUR profile. A fake chat_id is fine for the dry-run;
--     the sweep only needs the row to exist + telegram_enabled + a chat_id.
update user_profiles
   set telegram_enabled = true,
       telegram_chat_id = '000000000',
       timezone = 'UTC'              -- match current_date below (UTC) to avoid day drift
 where user_id = '<YOUR_USER_ID>';

-- (b) A throwaway subscription that renews in 3 days -> the 3-day reminder is
--     due TODAY. notification_channels MUST include 'telegram' (the channel gate).
insert into subscriptions
  (user_id, name, start_date, billing_cycle, interval_count, currency, amount,
   reminder_offsets_days, notification_channels, is_trial, is_paused, is_cancelled)
values
  ('<YOUR_USER_ID>', 'ZZ-Phase3-Test (delete me)',
   (current_date + interval '3 days')::date,
   'monthly', 1, 'USD', 12.99,
   '{7,3,1}', '{telegram,in_app}', false, false, false);
```

### Test 2.1 — dry-run derives the reminder  *(proves §6.2)*
```powershell
$h = @{ Authorization = "Bearer $env:CRON_SECRET" }
Invoke-RestMethod -Headers $h "http://localhost:3000/api/cron/reminders?dry=1"
```
Expect `derived: 1` and a `reminders[]` entry:
```json
{ "name":"ZZ-Phase3-Test (delete me)", "chargeISO":"<today+3>", "offsetDays":3, "kind":"renewal", "dueISO":"<today>" }
```
> **0 derived?** Day-boundary drift. Re-run the SQL with `interval '2 days'` and
> `interval '4 days'` as extra rows — at least one will land on a due date.

### Test 2.2 — real run inserts the ledger row + attempts send
```powershell
Invoke-RestMethod -Headers $h "http://localhost:3000/api/cron/reminders"
```
Because the chat_id is fake, the send will `fail` (or `skip` if
`TELEGRAM_BOT_TOKEN` is unset). Either way the route returns **200** with a
summary like `{ sent:0, failed:1 }` or `{ skipped:1 }`.
In Supabase → **Table Editor → notification_deliveries** you'll see one row with
`dedupe_key = '<subId>:telegram:3:<today+3>'`.

### Test 2.3 — re-run sends nothing (idempotency)  *(proves §6.3)*
```powershell
Invoke-RestMethod -Headers $h "http://localhost:3000/api/cron/reminders"
```
Expect the **same single ledger row** (no new insert), `sent` stays flat, and the
summary counts it as `skipped` (already sent/skipped) or re-attempts only if the
first was `failed`. **No duplicate row, no duplicate message.**

### Test 2.4 — pause kills the reminder  *(proves §6.4 / D1)*
```sql
update subscriptions set is_paused = true where name = 'ZZ-Phase3-Test (delete me)';
```
```powershell
Invoke-RestMethod -Headers $h "http://localhost:3000/api/cron/reminders?dry=1"
```
Expect `derived: 0` (the `reminders[]` array no longer contains it). Then:
```sql
update subscriptions set is_paused = false where name = 'ZZ-Phase3-Test (delete me)';
```

---

## Layer 3 — Deploy + register the webhook (public URL required)

The connect flow needs a public HTTPS URL for Telegram to call back to.

### 3.1 Deploy to Vercel
```powershell
vercel            # preview deploy (or push to your branch)
```

### 3.2 Set env vars on Vercel
Project → **Settings → Environment Variables** (for Preview + Production):
`NEXT_PUBLIC_DATA_SOURCE=supabase`, the four Supabase keys,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`,
`CRON_SECRET`. **Redeploy** after adding (env is baked at deploy time).

### 3.3 Register the webhook (once)
```powershell
$preview = "https://<your-preview>.vercel.app"
curl.exe "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/setWebhook?url=$preview/api/integrations/telegram/webhook&secret_token=$env:TELEGRAM_WEBHOOK_SECRET"
# Expect: {"ok":true,"result":...,"description":"Webhook was set"}
```
Verify it's set:
```powershell
curl.exe "https://api.telegram.org/bot$env:TELEGRAM_BOT_TOKEN/getWebhookInfo"
```
(`last_error_message` here is your live debugging channel if the webhook 500s.)

---

## Layer 4 — Telegram connect flow  *(proves D5)*

1. Open the deployed site, sign in → **Settings**.
2. Click **Connect Telegram** → a `t.me/<bot>?start=<code>` link opens.
3. In Telegram, tap **Start**.
4. Expect a reply: **“✅ Connected — you'll get renewal reminders here.”**
5. Verify in Supabase → `user_profiles`: your row now has a real
   `telegram_chat_id` and `telegram_enabled = true`.
6. Back on Settings, click **Send test message** → a test message arrives in Telegram.

> Didn't connect? Check `getWebhookInfo` → `last_error_message`, and the Vercel
> function logs for `/api/integrations/telegram/webhook`.

---

## Layer 5 — Live end-to-end delivery  *(proves §6.5 happy path)*

Now that your real chat is linked, re-seed a due reminder and trigger the sweep
on-demand (don't wait for 02:00 UTC / 10:00 MYT):

```sql
-- renew tomorrow -> the 1-day reminder is due today, to YOUR real chat
update subscriptions
   set start_date = (current_date + interval '1 days')::date,
       is_paused = false, is_cancelled = false,
       notification_channels = '{telegram,in_app}',
       reminder_offsets_days = '{7,3,1}'
 where name = 'ZZ-Phase3-Test (delete me)';
```
Trigger the sweep on the deployed URL:
```powershell
$h = @{ Authorization = "Bearer $env:CRON_SECRET" }
Invoke-RestMethod -Headers $h "https://<your-preview>.vercel.app/api/cron/reminders"
```
Expect: a Telegram message lands —
`⏰ ZZ-Phase3-Test (delete me) renews tomorrow — <date> · $12.99 · RM 57.86` —
and `notification_deliveries` shows a row `status = sent`.
Run it again → **no second message** (idempotent).

---

## Layer 6 — Failure handling  *(proves §6.5 failure path)*

### 6.1 Broken token → `failed`, route still 200
Temporarily set `TELEGRAM_BOT_TOKEN` to garbage on Vercel, redeploy, then trigger
the sweep. Expect: route returns **200** with `failed > 0`; the ledger row is
`status = failed` with the Telegram API error in `error_message`. The bad token
does NOT abort the run.

### 6.2 Retry within 48h
Fix the token, redeploy, trigger the sweep again. The previously-`failed` row is
re-attempted (counted in `retriesAttempted`) and flips to `sent`.

---

## Layer 7 — Settings UI + deliveries list  *(proves §6.6 + Task 6/7)*

- Visit `/settings` on the deployed site (and locally in mock data mode too):
  - Connect status chip, Connect/Test/Toggle buttons render.
  - **Recent reminders** card lists the last 10 deliveries with status chips
    (Sent / Failed / Skipped) — your test sends should appear here.

---

## Cleanup (after testing)

```sql
delete from notification_deliveries
 where subscription_id in (select id from subscriptions where name like 'ZZ-Phase3-Test%');
delete from subscriptions where name like 'ZZ-Phase3-Test%';
-- only if you want to disconnect Telegram:
update user_profiles set telegram_chat_id = null, telegram_enabled = false
 where user_id = '<YOUR_USER_ID>';
```

---

## §6 acceptance checklist (copy-paste summary)

| # | Criterion | Proven by |
|---|---|---|
| 1 | `typecheck` + `build` pass | ✅ already green |
| 2 | dry-run lists derived reminders; wrong bearer → 401 | Test 1.1, 2.1 |
| 3 | real run inserts once; re-run sends nothing | Test 2.2, 2.3 |
| 4 | pausing stops derivation | Test 2.4 |
| 5 | connect stores chat_id; test delivers; failure → ledger `failed`, 200 | Layer 4, 5, 6 |
| 6 | settings renders with graceful empties | Layer 7 |

---

## Troubleshooting

- **`401 unauthorized`** on a correct bearer → `CRON_SECRET` differs between the
  shell and the route env, or has trailing whitespace.
- **`503 server not configured`** → `SUPABASE_SERVICE_ROLE_KEY` missing.
- **`users: 0`** in dry-run → no `user_profiles` row has `telegram_enabled = true`
  AND a non-null `telegram_chat_id`. The sweep only considers those.
- **`derived: 0`** with a seeded sub → its `notification_channels` doesn't include
  `telegram`, or the charge date isn't `today+{7,3,1}` in the profile's timezone.
- **Webhook never fires** → confirm `getWebhookInfo` shows your preview URL with no
  `last_error_message`, and that the bot username in `TELEGRAM_BOT_USERNAME` has no
  leading `@`.
- **Vercel Cron not firing on deploy** → on Hobby, confirm the cron appears under
  Project → Settings → Cron Jobs; it runs daily at 02:00 UTC (10:00 MYT). For on-demand tests,
  always curl the route manually with the bearer.
