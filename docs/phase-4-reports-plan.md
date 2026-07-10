# Phase 4 — Monthly & Yearly Reports (Implementation Plan)

> **Audience:** the implementing model (Sonnet 5). This is a *plan* — no Phase-4
> code exists yet. Read `CLAUDE.md` first; all its conventions apply (data-source
> switch, civil dates via `parseISODate`, MYR money rules, RLS vs service-role
> split, `pnpm typecheck` after every task, no test runner, pnpm only).
>
> **Standing user constraint: do NOT commit any work.** Leave everything in the
> working tree. The user commits manually.
>
> **Owner decisions locked in (2026-07-10, via advisor Q&A):**
> 1. **Timing:** reports generate on the **1st of the month** (per-user
>    timezone), covering the **previous, fully-closed month**. Yearly on Jan 1
>    covering the previous year.
> 2. **Consumption:** **in-app report page + Telegram highlights message with a
>    deep link** (the Strava/Spotify/GitHub statement pattern).
> 3. **Scope:** **monthly AND yearly** in this phase (yearly is a thin variant
>    of the same builder).
> 4. **Content:** all four sections — spend summary + MoM delta, category
>    breakdown, itemized charge list, forward look.
> 5. WhatsApp is deferred to Phase 5 (`docs/phase-5-whatsapp-integration-plan.md`).

---

## 0. Design philosophy (how top-tier SaaS does statements)

A monthly report is a **statement**: it describes a *closed* period, it is
**generated once and stored immutably** (a snapshot, not a live query), and its
delivery is **separate from its generation** (a Telegram outage must not lose
the report — it lives in the app regardless). The architecture below follows
exactly the patterns already proven in this repo's reminders phase:

| Pattern | Where it comes from | How Reports uses it |
| --- | --- | --- |
| Pure domain derivation, I/O-free | `lib/reminders/engine.ts` | `lib/reports/build.ts` — pure builders, caller passes subs + period |
| Idempotency via unique key | `dedupe_key` ledger index | `monthly_reports (user_id, month_key)` unique constraint (already in DB) |
| Generation ≠ delivery (outbox) | `notification_deliveries` | report row = artifact; Telegram send = ledger row `${userId}:telegram:report:${key}` |
| Per-user timezone civil dates | `todayISOFor()` in reminders cron | "is today within the first 3 days of a new month in the user's TZ?" |
| Catch-up window for missed runs | reminders' yesterday catch-up | 3-day generation window; unique key makes catch-up double-send-proof |
| Snapshot versioning | — (new) | `totals_json = { v: 1, ... }` — the page renders the stored snapshot, never recomputes history |

**Why snapshot, not live recompute:** the charge engine derives from *current*
subscription state. If a user deletes a subscription in August, a live-computed
"June report" would silently change. Statements must not change retroactively —
so `totals_json` is written once and the report page renders **from the stored
snapshot**. (The one exception is the owner-triggered manual regeneration,
R6 — the user rewriting their own statement on demand is fine for a tracker.)

---

## 1. Current state (verified in the tree — surprisingly complete)

| Piece | Where | Status |
| --- | --- | --- |
| `monthly_reports` table (unique `user_id, month_key`; `report_html`, `report_pdf_url`, `totals_json`, `delivered_channels_json`; RLS "own monthly reports") | `0001_init.sql` | ✅ live — **no migration needed** |
| `yearly_reports` table (same shape, `year_key`) | `0001_init.sql` | ✅ live |
| Profile flags `monthly_report_enabled`, `yearly_report_enabled` (default `true`) | `user_profiles` | ✅ live |
| Generated types for both tables | `lib/supabase/types.ts` | ✅ present |
| All report math | `lib/domain/`: `monthlyAmount`, `yearlyAmount`, `grossMonthlyCost`, `chargeDatesInRange`, `subscriptionsChargingInRange`, `monthBounds`, `toMYR`/`formatMYR`, `roundMoney` | ✅ pure + reusable |
| Reference implementation of every section | `features/subscriptions/subscription-statistics.tsx` (totals, category ring, upcoming, trial conversions, cancellation savings) | ✅ extract, don't duplicate |
| Delivery transport + ledger | `lib/notify/telegram.ts`, `notification_deliveries` + dedupe pattern in `app/api/cron/reminders/route.ts` | ✅ reuse patterns verbatim |
| Cron auth + sweep skeleton | `app/api/cron/reminders/route.ts` (`CRON_SECRET` bearer, `todayISOFor`, dry-run, structured-JSON error handling) | ✅ the blueprint |
| Cron scheduling | `vercel.json` (1 of 2 Hobby cron slots used) | ⚠️ Reports takes the **second and last** Hobby slot |
| Recharts + category color tokens (`--cat-*`) | statistics tab, `app/globals.css` | ✅ reuse on the report page |

**Zero schema changes.** `report_pdf_url` stays `NULL` — PDF generation is
explicitly out of scope (headless-browser rendering is a poor fit for
serverless; the HTML export IS the export).

---

## 2. Architecture decisions

### R1 — Periods, keys, and the generation window
- **Monthly:** covered period = the calendar month *before* the user's civil
  today. `month_key = "YYYY-MM"` of the **covered** month (June's report,
  delivered 1 July, has `month_key = "2026-06"`).
- **Yearly:** covered period = previous calendar year; `year_key = "YYYY"`.
  Generated when the user's civil today is in **January**.
- **Generation window (catch-up):** generate when `dayOfMonth(todayLocal) <= 3`
  AND no report row exists for the covered period. A cron outage on the 1st
  self-heals on the 2nd/3rd; the unique constraint makes overlapping runs safe
  (insert conflict → skip, same 23505 discipline as reminders). After day 3 a
  missed month is NOT backfilled by cron (owner can trigger manually, R6).
- All date math uses civil dates: `todayISOFor(timezone)` (copy the helper or
  export it from a shared `lib/reports/period.ts`), `monthBounds(year, month0)`
  from `lib/domain/calendar.ts`. Never `new Date("YYYY-MM-DD")`.

### R2 — Pure builder layer: `lib/reports/`
New module, framework-agnostic like `lib/domain/`:
- `lib/reports/types.ts` — versioned snapshot schemas:
  ```ts
  interface MonthlyReportTotalsV1 {
    v: 1;
    monthKey: string;            // "2026-06"
    generatedOnISO: string;      // civil date of generation
    // §Spend summary
    totalMYR: number;            // sum of charges that LANDED in the month
    prevMonthTotalMYR: number;   // same computation over the prior month
    deltaPct: number | null;     // null when prev == 0 (avoid div-by-zero)
    activeCount: number;
    recurringMonthlyMYR: number; // normalized /mo figure (the OTHER usage number)
    // §Category breakdown (only categories with spend, sorted desc)
    categories: { category: string; label: string; totalMYR: number }[];
    // §Itemized charges ("statement lines", sorted by date)
    charges: { dateISO: string; name: string; amount: number; currency: string;
               amountMYR: number; category: string; isTrialConversion: boolean }[];
    // §Forward look
    upcoming: { dateISO: string; name: string; amountMYR: number }[]; // next month
    upcomingTotalMYR: number;
    trialsConverting: { name: string; dateISO: string; amountMYR: number }[];
    cancellationSavingsMYR: number; // Σ grossMonthlyCost of cancelled subs
  }
  interface YearlyReportTotalsV1 {
    v: 1;
    yearKey: string;
    generatedOnISO: string;
    totalMYR: number;
    prevYearTotalMYR: number;
    deltaPct: number | null;
    monthlyBuckets: { monthKey: string; totalMYR: number }[]; // 12 entries
    categories: { category: string; label: string; totalMYR: number }[];
    topSubscriptions: { name: string; totalMYR: number }[];   // top 5 by year spend
    cancellationSavingsMYR: number;
  }
  ```
- `lib/reports/build.ts` — `buildMonthlyReport(subs, monthKey)` and
  `buildYearlyReport(subs, yearKey)`. **PURE: no I/O, no clock reads.**
  Implementation notes:
  - "Charges that landed in the period" = `chargeDatesInRange(sub, startISO,
    endISO)` per active sub over `monthBounds` — the same semantics the
    calendar and the "this month (actual)" dock figure use. A trial conversion
    is a charge whose date equals the sub's `freeTrialEndAt`.
  - **Money rule (CLAUDE.md):** convert each charge to MYR, sum at full
    precision, `roundMoney` once per stored figure.
  - MoM/YoY delta: compute the previous period with the SAME builder logic —
    do NOT read the previous stored report (first-ever report still gets a
    delta; a missing prior row can't corrupt the math).
  - Forward look uses the month AFTER the covered one (= the month the user
    receives the report in): `subscriptionsChargingInRange` over its bounds,
    plus `isTrialConvertingWithin`-style trial detection, plus the
    cancellation-savings sum exactly as `subscription-statistics.tsx` does.
  - Category labels/colors come from `CATEGORIES` / `CATEGORY_META` — reuse,
    don't re-declare.
- **Refactor guard:** extract any computation you'd otherwise copy from
  `subscription-statistics.tsx` into shared pure helpers rather than
  duplicating; statistics must keep rendering identically (typecheck + visual
  smoke on the Statistics tab).

### R3 — HTML export renderer: `lib/reports/html.ts`
- `renderMonthlyReportHTML(totals)` / `renderYearlyReportHTML(totals)` →
  a **fully self-contained** HTML document string: inline CSS only, no JS, no
  external assets/fonts (it must render from a file:// download). Simple
  statement styling; CSS bars for the category breakdown (no chart lib).
- Escape every user-controlled string (sub names) — write a tiny
  `escapeHtml()` there; do NOT reuse `escapeTelegramHTML` (different context,
  Telegram's escapes only 3 chars).
- Stored into `report_html` at generation time; served by the export route (R7).

### R4 — Telegram highlights message
- `buildMonthlyReportMessage(totals, appUrl)` / yearly variant — in
  `lib/notify/messages.ts` (keeps all Telegram formatting in one file, reusing
  `escapeTelegramHTML`):
  ```
  📊 <b>Your June report</b>
  Spent: RM 312.40 (▲ 5% vs May) · 14 active subs
  Top: Streaming RM 120 · SaaS RM 96 · Music RM 45
  Next month: ~RM 298.10 expected, 1 trial converting

  <a href="https://app…/reports/2026-06">Open the full report</a>
  ```
- Compact by design (well under Telegram's 4096-char limit); the page carries
  the detail. Link built from `NEXT_PUBLIC_APP_URL` (already in env).

### R5 — Cron route: `app/api/cron/reports/route.ts`
Clone the reminders sweep skeleton (auth, structure, error discipline):
- `runtime = "nodejs"`, `dynamic = "force-dynamic"`, `maxDuration = 300`.
- Auth: `Authorization: Bearer ${CRON_SECRET}` → 401 otherwise. `?dry=1`
  returns what WOULD generate/send, writes nothing.
- **Second cron entry in `vercel.json`:** `{ "path": "/api/cron/reports",
  "schedule": "0 3 * * *" }` (an hour after reminders; both fit Hobby's 2-job
  limit — this uses the LAST slot; flag it in the doc comment).
  Decision note: a separate route (not folded into the reminders sweep) keeps
  failure domains and maxDuration budgets independent — statement generation
  must never delay reminder delivery.
- Sweep shape (service-role admin client):
  1. Page through `user_profiles` (stable `order("user_id")` + `.range()`,
     500/page) selecting `user_id, timezone, telegram_chat_id,
     telegram_enabled, monthly_report_enabled, yearly_report_enabled`.
     **Generate for every user with a report flag enabled** — the in-app page
     has value even without Telegram. Deliver only to linked+enabled Telegram.
  2. Per user: `todayISOFor(tz)`; if day-of-month ≤ 3 → covered
     `monthKey` = previous month; if also month == January → covered
     `yearKey` = previous year.
  3. Skip fast: batched existence check — one query per page for
     `monthly_reports.month_key = <covered>` across the page's user ids
     (`.in("user_id", ids)`), same for yearly. Only fetch subscriptions
     (chunked `.in("user_id", …)`, ~100/chunk) for users who still need
     generation — after month 1 the steady-state sweep does near-zero work
     on days 2–3.
  4. Generate (pure builders) → insert report row (`totals_json`,
     `report_html`; conflict → skip). Map rows with `rowToSubscription`
     before passing to builders.
  5. Deliver: insert `notification_deliveries` row with dedupe key
     `${userId}:telegram:report:${monthKey}` (payload: message text/html,
     recipient chat id, `{ report: true, key }`) → send via
     `telegramProvider` → set `sent/failed/skipped` — the exact
     `deliverDigest`/`sendAndUpdate` discipline (atomic claim on retry,
     terminal-success short-circuit). Update `delivered_channels_json` on the
     report row (`[{ channel: "telegram", at, status }]`).
  6. Failed report sends are retried by THIS route on subsequent daily runs
     (days 2–3 window) via the same claim-if-failed pattern; after the window
     they surface in the settings deliveries list (already renders any channel
     row) — no new retry machinery.
- Summary counters: `{ users, monthlyGenerated, yearlyGenerated, sent,
  skipped, failed, truncated }` + 240s soft time budget.
- **Ops alert (carried from the Phase-5 plan since it's channel-agnostic):**
  new `lib/notify/ops-alert.ts` — `sendOpsAlert(text)`, fire-and-forget, no-op
  unless `OPS_ALERT_TELEGRAM_CHAT_ID` is set (reuses `TELEGRAM_BOT_TOKEN`).
  Fire once per sweep when `failed > 0`, the sweep throws, or `truncated > 0`.
  Silent when green. (The reminders sweep adopts it in a later hardening pass —
  do not modify the reminders route in this phase.)

### R6 — Manual generation: `POST /api/reports/generate`
The on-demand + test surface (industry: "regenerate statement"):
- Session-authed (server client, RLS) + `Sec-Fetch-Site` CSRF guard — mirror
  `app/api/integrations/telegram/connect/route.ts`'s guard exactly.
- Body: `{ periodKey: "2026-06" | "2025" }` (validated: `^\d{4}-\d{2}$` or
  `^\d{4}$`; covered period must be fully in the past — reject the current
  month/year with 400, statements only cover closed periods).
- **Regenerates (upsert-overwrite) the caller's own report row** — totals AND
  html. Does NOT send Telegram and does NOT touch the deliveries ledger
  (dedupe key unchanged → no accidental re-send; document this in a comment).
- Rate limit: cheap in-route guard — reject if the row's `created_at`… (no
  update timestamp exists; skip it — RLS confines the blast radius to the
  user's own rows and generation is cheap; note the decision).
- This endpoint uses the **user's RLS client** (their own subs, their own
  report row) — no service role anywhere in R6/R7.

### R7 — In-app pages + export
- `app/(app)/reports/page.tsx` (server component): list the signed-in user's
  reports (both tables, newest first) + a "Generate last month" button (client
  island calling R6) for first-time users who don't want to wait for the cron.
  Empty state for mock mode / no reports yet.
- `app/(app)/reports/[periodKey]/page.tsx` (server component): validate
  `periodKey` (`YYYY-MM` → monthly table, `YYYY` → yearly) else `notFound()`.
  Fetch via RLS server client; render **from `totals_json`** (narrow on
  `v === 1`, else show a "regenerate" prompt). Sections: headline stat tiles
  (spent, delta, active, next-month), category breakdown (client chart
  component reusing Recharts + `--cat-*` tokens exactly like the statistics
  tab), statement-lines table, forward-look list. Server-compute nothing from
  "now" (deterministic SSR rule) — everything comes from the snapshot.
- Download: `GET /api/reports/[periodKey]/export` — session-authed RLS fetch,
  returns `report_html` with `Content-Type: text/html` +
  `Content-Disposition: attachment; filename="report-2026-06.html"`.
- Navigation: add a **Reports** item (icon: `FileText` or `BarChart3` from
  lucide) to the sidebar + mobile bottom nav in
  `components/layout/app-shell.tsx`, matching the existing nav item pattern.
- The deep link from Telegram lands here; `middleware.ts` already redirects
  unsigned visitors through `/login` and back.

### R8 — Settings card: `features/settings/reports-card.tsx`
Mirror `telegram-card.tsx`'s optimistic-toggle/flash patterns:
- Two toggles: Monthly report / Yearly report → `POST /api/settings/reports`
  (new sibling of `app/api/settings/reminders/route.ts`, session + CSRF,
  writes `monthly_report_enabled` / `yearly_report_enabled`).
- Hint line: "Reports are generated on the 1st and sent via Telegram if
  connected — they always appear in Reports either way." Link to `/reports`.
- Mount in `app/(app)/settings/page.tsx` (+ a skeleton block in `loading.tsx`),
  extending the page's existing profile select with the two flags.

### R9 — Mock-mode behavior (CLAUDE.md data-source rule)
Reports read/write Supabase tables that have no mock-repo equivalent. With
`NEXT_PUBLIC_DATA_SOURCE=mock`: the Reports pages render the empty state with
a "reports need the Supabase backend" note; the generate endpoint returns 503;
the cron route already requires the admin client. Do NOT extend the mock repo
for this phase — document the limitation in the pages' comments.

### OUT of scope (do not build)
PDF generation (`report_pdf_url` stays null); email channel; WhatsApp
(Phase 5); report scheduling preferences (day-of-month choice); cross-user/
admin analytics; charts inside `report_html` beyond CSS bars; backfilling
months older than the previous period via cron (manual R6 covers it);
modifying the reminders sweep.

---

## 3. Execution order (tasks for the implementer)

Work top-to-bottom; each task ends `pnpm typecheck` green. **No commits.**
No new npm dependencies (Recharts is already installed; native `fetch` only).

| # | Task | Files | Acceptance |
| --- | --- | --- | --- |
| 1 | Period helpers + snapshot types | `lib/reports/period.ts` (todayISOFor, prevMonthKey, prevYearKey, periodKey validators, monthKey↔bounds via `monthBounds`), `lib/reports/types.ts` | pure; civil-date rules respected; `2026-01` → prev month `2025-12` rollover correct |
| 2 | Pure builders | `lib/reports/build.ts` (+ extract shared helpers rather than copying from `subscription-statistics.tsx`) | pure (no I/O/clock); MYR money rule (sum full precision, round once); deltaPct null-safe; trial conversions flagged; Statistics tab unchanged |
| 3 | HTML export renderer | `lib/reports/html.ts` | self-contained document (inline CSS, no JS/external assets); user strings escaped; renders both report kinds |
| 4 | Telegram message builders | `lib/notify/messages.ts` | compact highlights + deep link per R4; `escapeTelegramHTML` on user strings; well under 4096 chars |
| 5 | Ops-alert helper | `lib/notify/ops-alert.ts` | fire-and-forget, never throws, no-op when env unset |
| 6 | Cron sweep + schedule | `app/api/cron/reports/route.ts`, `vercel.json` | R5 shape: CRON_SECRET auth, dry-run, 3-day window, batched existence checks + chunked sub fetches, generation→delivery separation, dedupe key `${userId}:telegram:report:${key}`, `delivered_channels_json` updated, summary + time budget + ops alert; second cron entry `0 3 * * *` |
| 7 | Manual generate + export routes | `app/api/reports/generate/route.ts`, `app/api/reports/[periodKey]/export/route.ts` | R6/R7: session + CSRF, RLS client only, periodKey validated, closed-periods-only, upsert-overwrite without touching deliveries; export streams stored HTML as attachment |
| 8 | Report pages + nav | `app/(app)/reports/page.tsx`, `app/(app)/reports/[periodKey]/page.tsx`, chart client component, `components/layout/app-shell.tsx` | index lists both kinds; detail renders from snapshot only (v-checked); Recharts + `--cat-*` tokens match Statistics; notFound on bad key; nav item on desktop + mobile; mock-mode empty state |
| 9 | Settings card + API | `features/settings/reports-card.tsx`, `app/api/settings/reports/route.ts`, `app/(app)/settings/page.tsx`, `loading.tsx` | toggles persist per R8; optimistic UI matches telegram-card; skeleton added |
| 10 | Env + docs | `.env.example` (`OPS_ALERT_TELEGRAM_CHAT_ID`, commented), `docs/phase-4-testing-guide.md` | guide: cron curl (dry + real) with CRON_SECRET, manual-generate walkthrough, Telegram link click-through, idempotency re-run proof, SQL verification snippets |
| 11 | Final verify | — | `pnpm typecheck` + `pnpm build` green (page-data collection flakes: retry once); §5 checklist walked with proofs |

---

## 4. Tools the implementer should use (MCP / connector requirements)

| Tool | Needed for | Status |
| --- | --- | --- |
| `pnpm typecheck` / `pnpm build` | every task / final gate | local, no setup |
| **Supabase MCP** — `execute_sql` | read-only verification (report rows, dedupe rows, delivered_channels_json) | ✅ already connected |
| **Supabase MCP** — `apply_migration` / `generate_typescript_types` | **NOT needed** — zero schema changes this phase | — |
| Telegram Bot API | delivery — plain HTTPS via existing `TELEGRAM_BOT_TOKEN` | ✅ no connector |
| Vercel cron | second `vercel.json` entry (last Hobby slot) | config-only; Vercel CLI not required |
| ❌ No new MCP servers, connectors, email services, or PDF services | — | — |

---

## 5. Verification checklist (definition of done)

1. `pnpm typecheck` + `pnpm build` pass.
2. **Builder correctness:** for a seeded user, `buildMonthlyReport` totals match
   the calendar tab's "this month (actual)" figure for the covered month, and
   `recurringMonthlyMYR` matches the dock's normalized figure. Statistics tab
   renders unchanged.
3. **Cron dry-run** (`?dry=1`) on a day ≤ 3 lists the pending generation for a
   user without a report row; a user who already has the row is absent.
4. **Real run** creates the `monthly_reports` row (`totals_json.v === 1`,
   `report_html` non-empty), one `notification_deliveries` row
   (`${userId}:telegram:report:<monthKey>`, `status=sent`), the Telegram
   message arrives with a working deep link, `delivered_channels_json`
   records it. **Immediate re-run: zero new rows, zero sends.**
5. **January path:** with a January civil date (timezone trick or seeded TZ),
   both monthly (December) and yearly (previous year) generate.
6. **Telegram-less user** with reports enabled: report row generated, delivery
   row `skipped` (or absent per implementation choice — document which), page
   shows the report.
7. **Manual generate:** rejects current/future periods (400) and bad keys;
   regenerates a past month idempotently; never re-sends Telegram.
8. **Export** downloads self-contained HTML that renders standalone (open the
   file directly in a browser).
9. **RLS proof:** user B cannot fetch user A's report via page or export route
   (execute_sql check + a curl with wrong session).
10. **Ops alert:** a forced failure (e.g. bad bot token in a dev env) produces
    exactly one alert; a green sweep produces none.
11. **Mock mode:** `/reports` renders the empty-state note, nothing 500s.

---

## 6. What the USER (owner) must do — not the implementer

| When | What | Notes |
| --- | --- | --- |
| Before task 6 verify | Confirm `CRON_SECRET` is set in Vercel env (already used by reminders) | no new secret needed |
| Optional, before task 10 | Set `OPS_ALERT_TELEGRAM_CHAT_ID` to your own chat id | your pager for failed sweeps |
| After deploy | Confirm both cron jobs appear in the Vercel dashboard (reminders 02:00, reports 03:00 UTC) | Hobby's 2-slot limit is now fully used — the next scheduled job requires Pro or route consolidation |
| First month | Click "Generate last month" on `/reports` to see your first report immediately instead of waiting for the 1st | uses R6 |
