# Reminder Integration — Plain-English Testing Guide

> No technical background needed. This walks you through setting up the Telegram
> reminder bot **once**, connecting **your** Telegram, then creating a trial
> subscription in the app and watching the bot send you a real reminder.

---

## First: how does the bot know which Telegram account to send to? 🤖

This is the key idea, so let's clear it up before anything else.

Your **website account** and your **Telegram account** are two separate things.
The bot has no way to know they're the same person until you **link them**.
Here's how that link is made — it happens once, in the **Settings** page:

```
   You (signed into the website)              The Telegram bot
   ─────────────────────────────              ────────────────
   1. Click "Connect Telegram"
      → the website builds a private link
        tagged secretly with YOUR account
        (only valid for ~10 minutes)                 │
                                                    ▼
   2. The link opens Telegram:                     picks up the tag
      "Open @YourReminderBot?start=XXXX"           + your chat id
                          │
                          ▼
   3. You tap  [ START ]  in Telegram  ──────────►  "Aha! This Telegram chat
                                                    belongs to THIS website
                                                    user." → saves your
                                                    Telegram chat id against
                                                    your account.
   4. From now on, when a reminder is due, the bot sends to that saved chat id.
      Only yours. Nobody else gets your reminders.
```

**In one sentence:** the first time you tap *Connect Telegram → Start*, the bot
records *"this Telegram chat belongs to you"* — and after that it always sends
your reminders to that chat.

> ✅ **This means:** every person who wants reminders does the *Connect
> Telegram* step once on their own account. Each person's reminders go to their
> own Telegram. You never type anyone's phone number or username.

---

## Part A — One-time setup (do this once, ever)

You only do this section once for the whole app. After it, everyone just uses
*Settings → Connect Telegram*.

### A1. Create the bot in Telegram (2 minutes)
1. Open Telegram. Search for **@BotFather** and open it.
2. Send `/newbot`.
3. It asks for a **name** — type anything, e.g. `Subscription Reminders`.
4. It asks for a **username** — must end in `bot`, e.g. `mysubs_reminders_bot`.
5. BotFather replies with a long **HTTP API token**. **Copy it.**
   → This is your **bot token** (looks like `7123...:AAH...`).
6. Your **bot username** is the one from step 4, **without the @**
   (e.g. `mysubs_reminders_bot`).

### A2. Add 4 settings to the website
Whoever deploys the site (you) adds these in **Vercel → your project → Settings →
Environment Variables** (set for *Production* and *Preview*), then **redeploys**:

| Setting name | Value | Where it comes from |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | the token from A1 step 5 | BotFather |
| `TELEGRAM_BOT_USERNAME` | the username from A1 step 6 (no @) | BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | any long random text | run `openssl rand -hex 24` |
| `CRON_SECRET` | any long random text (different from above) | run `openssl rand -hex 24` |

> ⚠️ Save the `TELEGRAM_WEBHOOK_SECRET` value — you'll paste it again in A3.

### A3. Tell Telegram where to send messages (one command)
This connects the bot to your website so it can receive the *Start* taps.
Replace the `<...>` parts and run once (PowerShell):

```powershell
$token   = "<TELEGRAM_BOT_TOKEN>"
$site    = "https://<YOUR-DEPLOYED-SITE>.vercel.app"   # your real site URL
$secret  = "<TELEGRAM_WEBHOOK_SECRET>"

curl.exe "https://api.telegram.org/bot$token/setWebhook?url=$site/api/integrations/telegram/webhook&secret_token=$secret"
```

You should see: `{"ok":true, ... "Webhook was set"}`.

> ✅ If you ever change the site URL (e.g. new preview), re-run A3 with the new URL.

**Setup done.** You never need to repeat Part A.

---

## Part B — Connect YOUR Telegram (once per person)

1. Open your website, **sign in**, and go to **Settings** (in the side menu / bottom nav).
2. Under **Telegram reminders**, click **Connect Telegram**.
3. A Telegram window opens → tap **Start**.
4. You should immediately get a message from the bot:

   > ✅ **Connected** — you'll get renewal reminders here.

5. Back on the website, click **Send test message**. You should get:

   > ✅ **Test message** — your Subscription Agent reminders are wired up.

> ✅ If both messages arrive, the link works. Your account is now paired with
> your Telegram chat. (If nothing arrives, see Troubleshooting below.)

### (Optional) Set your default reminder schedule

Also on **Settings**, the **Default reminder schedule** card controls *when* you
get reminded for every subscription at once:
- **Standard** = 7 / 3 / 1 days before; **Minimal** = 1 day before; or tick any
  combination (including **Same day**).
- This is the **default**. Individual subscriptions can still override it via
  their own **Remind me** chips (those show a **Custom schedule** badge). A sub
  with no custom setting simply follows this default.
- The card shows how many subscriptions use their own schedule, e.g. *"2
  subscriptions use their own schedule."*

---

## Part C — The real test: create a trial, get a reminder

Now the fun part. You'll add a **free-trial subscription** whose trial ends in a
few days, so a reminder is due **today**.

### C1. Add the trial subscription
1. Go to **Subscriptions** → click **+ Add**.
2. Fill in:
   - **Name**: anything, e.g. `Test Streaming`.
   - **Amount** + **Currency**: e.g. `15.99` USD.
   - **Billing**: Monthly.
   - Turn **ON** the **Free trial** toggle.
   - **Trial ends on**: pick a date **3 days from today**
     (e.g. if today is **10 Jul**, choose **13 Jul**).
3. ⚠️ **Important:** under notifications, make sure **Telegram** is **ticked**
   (the bot only sends for subscriptions that have Telegram enabled).
4. Save.

### C2. Make the reminder fire
Reminders go out **automatically once a day around 10:00 AM (Malaysia time)**.
For testing you have two options:

- **Option 1 — wait (fully automatic):** do nothing; the reminder lands after
  the next 10 AM run.
- **Option 2 — send it now (admin):** run this once to trigger immediately:

  ```powershell
  $site   = "https://<YOUR-DEPLOYED-SITE>.vercel.app"
  $secret = "<CRON_SECRET>"           # the one from A2
  Invoke-RestMethod -Headers @{ Authorization = "Bearer $secret" } "$site/api/cron/reminders"
  ```

  You'll see a small summary like `{ ok:true, sent:1, ... }`.

### C3. What you should receive in Telegram
A message like:

> ⏰ **Test Streaming** trial converts in 3 days — 13 Jul 2026 · $15.99 · RM 71.16

(The `RM ...` part only shows when the currency isn't already MYR. If you added
an unsubscribe link, a second line `Unsubscribe: …` appears.)

### C4. Confirm it was recorded
Go to **Settings → Recent reminders**. You should see one row:
**Test Streaming · telegram · Sent**.

> ✅ **That's a full pass:** subscription → bot → your phone → recorded.

---

## Part D — Important scenarios to test (checklist)

Do these to make sure the whole feature is solid, not just the happy path.

| # | Scenario | How | Expected result |
|---|---|---|---|
| 1 | Connect works | Part B | "✅ Connected" + test message arrives |
| 2 | Real **trial** reminder | Part C | "trial converts in 3 days" message arrives |
| 3 | Real **renewal** reminder | Add a *non-trial* subscription starting **3 days from today** (Telegram ticked), then trigger | "renews in 3 days" message arrives |
| 4 | **No duplicate** (idempotency) | Trigger the same sweep a 2nd time (re-run C2) | **No** second message; Settings still shows 1 row |
| 5 | **Pause stops** reminders | Pause the subscription, trigger again | No message; nothing new in Recent reminders |
| 6 | **Disable stops** reminders | In Settings turn reminders **off**, trigger again | No message sent to you |
| 7 | **Failure recovery** | (Admin) temporarily set a wrong `TELEGRAM_BOT_TOKEN`, trigger, then fix it and trigger again | First run: nothing arrives + Recent reminders shows **Failed**; after fixing: message arrives, row becomes **Sent** |
| 8 | **Disconnect / reconnect** | (If your bot supports it) connect a 2nd time | Works without error; latest chat is used |

> ⚠️ The two most important ones for user acceptance are **#2** (you actually get
> the right message for a trial) and **#4** (you never get spammed with
> duplicates).

---

## Troubleshooting (plain language)

- **"Connect Telegram" does nothing / no ✅ message arrives:**
  - Re-run **A3** (the webhook may point at an old/wrong URL).
  - In a browser open
    `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` — if
    `last_error_message` has text, that's the current problem.
- **You connected but reminders never come:**
  - Did you **tick Telegram** on the subscription's notifications? (Part C1 step 3.)
  - Is the trial date actually **3 days from today**? (1 or 7 also work; other
    gaps may not land on a reminder day.)
  - Did you **trigger** it (C2), or are you waiting for 10 AM?
  - In **Settings → Recent reminders**, is there a **Failed** row with a reason?
- **You get the message twice:**
  - You may have triggered the sweep twice very quickly while a previous one was
    still running. Wait a minute and it self-corrects; duplicates are blocked.
- **The website shows "Telegram isn't configured on the server":**
  - One of the 4 settings in **A2** is missing or spelled wrong. Re-check and
    redeploy.
- **`Invoke-RestMethod` errors with 401:**
  - The `CRON_SECRET` you typed doesn't match the one set on the website.

---

## Quick reference — the messages you're looking for

| When | Message |
|---|---|
| Right after connecting | ✅ **Connected** — you'll get renewal reminders here. |
| Test button | ✅ **Test message** — your Subscription Agent reminders are wired up. |
| Renewal due | ⏰ **\<Name\>** renews in 3 days — \<date\> · \<price\> |
| Trial converting | ⚠️ **\<Name\>** trial converts in 3 days — \<date\> · \<price\> |
| Bad/expired connect link | ⚠️ That link expired / is invalid. Open your dashboard and tap Connect again. |

Happy testing! 🎉
