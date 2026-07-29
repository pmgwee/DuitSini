# DuitSini

**Your day-to-day financing platform — three money surfaces in one place: what you're *committed* to paying, what your *AI tools* are burning, and what the *market* is doing. All in Ringgit.**

Built Malaysian-first: every figure is shown in **Ringgit (MYR)**, never USD you have to convert in your head.

Built with Next.js 15 (App Router), React 19, Tailwind v4, and Supabase.

---

## The three pillars

| Pillar | Route | What it answers |
|---|---|---|
| 💳 **Bills tracking** | `/bills` | What's about to charge me, and what am I really spending per month? |
| 🤖 **AI usage tracking** | `/ai-usage` | How much of my Claude / GLM plan have I burned — live, right now? |
| 📈 **Stocks analysis tracking** | `/stocks` | What's the current read on the market, and which names are in play? |

Everything else — reports, reminders, settings — exists to serve those three.

---

## Why people keep it open

- 🇲🇾 **MYR-native, always.** No mental USD→RM math for Netflix, Spotify, Claude, ChatGPT — every figure converts and rounds once, correctly.
- 🛰️ **Live AI usage, broadcast from your own machine.** Nobody else does this: a 2-minute setup turns your Claude Pro / GLM Coding plan usage into a live gauge — no API key ever leaves your computer.
- 📈 **Market vision without the doomscroll.** A reconstructed portfolio, theme map, and daily commentary read — parsed, cached, and attributed, so you get the signal without living on X.
- 🖥️ **Built for the spare monitor.** Leave it open on a third screen while gaming, vibe-coding, or running a side hustle — everything that costs or moves your money, always in view.
- 📄 **Monthly/yearly statements, delivered, not dug for.** Auto-generated PDF statements land in your Telegram — no logging back in to check what you spent.

---

## Features

### 💳 Bills tracking — `/bills`
Covers all three kinds of recurring outgoing: **subscriptions** (Netflix, Spotify, Claude),
**utilities** (TNB, Ranhill SAJ, Indah Water), and **bank repayments** — only the first of
which is literally a subscription, which is why the surface is called Bills.
- **Calendar** — monthly grid of upcoming charges, free-trial conversions, and renewals. Each day stacks provider icons; tap a day for its charge breakdown, with the focused month's renewals also listed as cards below the grid.
- **All** — searchable, sortable (date / amount / name / provider / payment method / status) list of every bill (active, trial, cancelled) with edit / cancel / restore / delete. Cancelling stamps a `cancelledAt` date rather than deleting — past charges stay on record, only future ones stop.
- **Statistics** — lazy-loaded charts (Recharts) breaking down spend by category, plus a 6-month cash-flow trend and cancellation savings.
- **Payment methods** — reusable instruments (credit/debit card, bank account, DuitNow, FPX, e-wallet, other) picked from a bank/e-wallet catalog or typed free-form; each subscription links to one, shown as a badge with the issuer's logo.
- **Category dock** — a sticky overview showing two differentiated figures:
  - _This month_ — the **actual** count + MYR of charges landing in the current month.
  - _Recurring_ — the **normalized** monthly cost (any billing cycle smoothed to /mo).

### 🤖 AI usage tracking — `/ai-usage`
Share your real Claude plan usage to the platform — no API key wrangling:
- **Windows** — download a ZIP, double-click `START-HERE (Windows).bat`.
- **macOS** — copy one Terminal command (`curl → node`). Uses the Homebrew/nvm pattern so it isn't blocked by Gatekeeper.
- Broadcasts **Claude Pro** _and_ **GLM Coding** usage side by side (read from a dedicated Claude login and your cc-switch setup respectively). Only usage percentages are ever sent — never your password or login.
- Every sharer command is personal — tied to the Google account that generated it, and the page tells you whose account it's feeding, on startup.
- Also on this surface: a YouTube Music player that docks inline here and floats elsewhere (surviving navigation), plus a flip clock.

### 📈 Stocks analysis tracking — `/stocks`
- **Opportunity radar** — dip framing on tracked names, using a live trailing-1-year % (Yahoo Finance, keyless) with a graceful fallback to "since tracked".
- **Holdings ring + theme constellation** — a reconstructed portfolio and its thematic clustering.
- **Latest posts** — the source account's X commentary, each linking back to the original post, with an All/Robot filter.
- Currently sourced from a single provider (`serenitytrades.com` + `trackserenity.com`, attributed in-app). The route is named for the *surface*, the module for the *provider* — so a second source can slot in without renaming the page.
- **Not investment advice**, and not affiliated with the tracked account. Holdings and conviction are estimates from public posts, not disclosed positions.

### Monthly & yearly reports
- Auto-generated statements (spend by category, totals, trends) on a daily cron sweep — no manual export.
- One-click **PDF** download, or push straight to **Telegram** as a document.
- Per-period detail pages so you can look back at any month or year.

### Reminders & Telegram
- Renewal reminders on a schedule you set (a global default, overridable per subscription), bundled into one daily digest per Telegram chat instead of one message per bill.
- Connect once; toggle report delivery and reminders independently from Settings, and manage saved payment methods there too.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router, Fluid Compute / serverless) |
| UI | React 19, Tailwind CSS v4, custom design system, Recharts |
| State | TanStack Query (server), Zustand (UI), `next-themes` (theme) |
| Backend | Supabase (Postgres, Auth, Row-Level Security, Realtime) |
| Cloud / APIs | Google Cloud — YouTube Data API v3 (music search), Google OAuth 2.0 (Google sign-in identity) |
| Market data | Yahoo Finance public chart endpoint (keyless, 1-day cache) |
| Forms / validation | React Hook Form + Zod |
| Testing | Vitest (pure `lib/` modules — the sharer policy modules + protocol schema) |
| Language | TypeScript (strict) |
| Package manager | pnpm |

---

## Getting started

### Prerequisites
- **Node.js 20+** (Node 24 recommended — the usage bridge uses the built-in `node:sqlite`)
- **pnpm**

### Install & run
```bash
pnpm install
cp .env.example .env     # then edit as needed
pnpm dev                 # http://localhost:3000
```

> **Note:** `pnpm build` and `pnpm dev` share the same `.next/` directory. Stop the dev
> server before building — running both at once corrupts the cache and produces
> phantom 500s (`Cannot find module './NNNN.js'`) until you `rm -rf .next` and restart.

### The data-source switch
`NEXT_PUBLIC_DATA_SOURCE` in `.env` selects the backend:

- **`mock`** (default) — runs immediately with in-memory demo data. No Supabase setup required; great for previewing the UI.
- **`supabase`** — production mode backed by Postgres + Auth (Google OAuth), scoped per-user by Row-Level Security.

See [`.env.example`](.env.example) for every variable and what each controls.

### Production build
```bash
pnpm build
pnpm start
```

---

## Architecture at a glance

```
app/
  (app)/            # authed shell — ai-usage, stocks, bills, reports, settings
  api/              # route handlers (bridge mint/serve, usage ingest/live, cron, stocks, YouTube)
  auth/callback, login
components/         # shared UI primitives + layout (app shell)
features/
  dashboard/        # AI-usage tracker, music player, connect-claude card, flip clock
  serenity/         # stocks provider UI (holdings ring, themes, posts feed)
  subscriptions/    # calendar, list, statistics, category dock, payment-method picker/badge
  reports/          # report detail page islands (hero total, category chart, send buttons)
  settings/         # Telegram, reminder schedule, reports toggles, payment methods card
lib/
  domain/           # pure money/date/renewal logic (the source of truth for figures)
  data/             # repository abstraction (mock ↔ supabase) — subscriptions + payment methods
  reminders/        # pure due-reminder derivation, consumed by the cron sweep
  notify/           # Telegram/WhatsApp provider registry + message builders
  reports/          # pure statement builders (monthly/yearly) + HTML/PDF renderers
  serenity/         # stocks provider data layer (fetch, parse, prices, merge)
  supabase/         # server / client / admin(service-role) clients
  bridge/           # the downloadable usage-sharer script builder + sharer/ (policy modules)
  payment-methods.ts# payment-instrument catalog (issuers/kinds) + card-network helpers
  providers.ts      # subscription-provider catalog (brand color/logo presets)
supabase/migrations/# SQL migrations (applied to the live project)
```

> **Naming note — routes name the *surface*, modules keep their original vocabulary.**
> `/stocks` is served by `features/serenity/` + `lib/serenity/` ("Stocks" is the pillar,
> "Serenity" is the current data provider — a second provider shouldn't rename the page).
> `/bills` is served by `features/subscriptions/` and the `subscriptions` table.
> `/ai-usage` is served by `features/dashboard/`. Renaming the modules, domain types and
> DB schema to match would mean a migration and a type regen for zero user-visible gain.

A few things that matter when working in this codebase:
- **MYR-home.** All totals convert to Ringgit via `lib/domain/fx.ts`; round once after summing.
- **Civil dates.** Charge dates are calendar dates, parsed via `parseISODate` (not `new Date(iso)`) to avoid timezone off-by-one.
- **Renewal engine.** Charge series are derived from `startDate + billingCycle` in `lib/domain/renewal.ts` — that's what powers "what's charged this month."
- **Single `cancelledAt` cutoff, no pause.** Stopping a subscription stamps today's date on `cancelledAt`; charges before it stay (paid history is preserved), charges on/after it drop. There's no separate pause state — the tracker never talks to the merchant, so pause and cancel were the same thing.
- **Deterministic SSR.** "Now"-dependent values are computed server-side and passed down (e.g. `todayISO`) to prevent hydration mismatches.

See [CLAUDE.md](CLAUDE.md) for the full architectural guide.

---

## Broadcasting your AI usage (Supabase mode)

1. Sign in (Google) and open **AI Usage** → **Share your Claude usage**.
2. **Windows:** click *Download my usage sharer*, unzip, run `START-HERE (Windows).bat`.
   **macOS:** switch the card to *macOS*, copy the one-line command, paste it into Terminal.
3. Keep the window open — your usage updates live on the page.

Want **both Claude Pro and GLM** live at once? Sign Claude Code into a dedicated config folder once (`CLAUDE_CONFIG_DIR=~/.claude-pro claude`, choose the Claude.ai subscription) — the sharer finds it automatically alongside your cc-switch GLM setup. See the in-app "Want both Claude Pro and GLM live at once?" guide.

Only usage percentages are sent — never credentials.

---

## Disclaimer

The stocks surface is a **derived, attributed view of public commentary** — not financial
advice, not a recommendation, and not affiliated with the accounts or sites it reads from.
Figures are estimates reconstructed from public posts. Do your own research.

---

## License

This project is currently unlicensed / for personal and educational use. Add a `LICENSE` before public distribution if needed.
