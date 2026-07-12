# Subscription Agent

**Your always-on second-screen dashboard: every subscription in Ringgit, your live Claude/GLM AI usage broadcast in real time, and monthly statements pushed straight to Telegram — no spreadsheets, no manual conversion, no API keys.**

Built Malaysian-first: every figure is shown in **Ringgit (MYR)**, never USD you have to convert in your head.

Built with Next.js 15 (App Router), React 19, Tailwind v4, and Supabase.

---

## Why people keep it open

- 🇲🇾 **MYR-native, always.** No mental USD→RM math for Netflix, Spotify, Claude, ChatGPT — every figure converts and rounds once, correctly.
- 🛰️ **Live AI usage, broadcast from your own machine.** Nobody else does this: a 2-minute setup turns your Claude Pro / GLM Coding plan usage into a live gauge on your dashboard — no API key ever leaves your computer.
- 🖥️ **Built for the spare monitor.** Leave it open on a third screen while gaming, vibe-coding, or running a side hustle — a calendar of what's about to charge you, plus your live AI usage, always in view.
- 📄 **Monthly/yearly statements, delivered, not dug for.** Auto-generated PDF statements land in your Telegram — no logging back in to check what you spent.

---

## Features

### Subscription manager
- **Calendar** — monthly grid of upcoming charges, free-trial conversions, and renewals. Each day stacks provider icons; tap a day for its charge breakdown. Below the grid, the focused month's renewals are listed as cards.
- **All** — searchable list of every subscription (active, trial, paused, cancelled) with edit / pause / resume / delete.
- **Statistics** — lazy-loaded charts (Recharts) breaking down spend by category, currency, and billing cycle.
- **Category dock** — a sticky overview showing two differentiated figures:
  - _This month_ — the **actual** count + MYR of charges landing in the current month.
  - _Recurring_ — the **normalized** monthly cost (any billing cycle smoothed to /mo).

### Live Claude usage broadcasting
Share your real Claude plan usage to the dashboard — no API key wrangling:
- **Windows** — download a ZIP, double-click `START-HERE (Windows).bat`.
- **macOS** — copy one Terminal command (`curl → node`). Uses the Homebrew/nvm pattern so it isn't blocked by Gatekeeper.
- Broadcasts **Claude Pro** _and_ **GLM Coding** usage side by side (read from a dedicated Claude login and your cc-switch setup respectively). Only usage percentages are ever sent — never your password or login.
- Every sharer command is personal — tied to the Google account that generated it, and the dashboard tells you whose account it's feeding, on startup.

### Monthly & yearly reports
- Auto-generated statements (spend by category, totals, trends) on a daily cron sweep — no manual export.
- One-click **PDF** download, or push straight to **Telegram** as a document.
- Per-period detail pages so you can look back at any month or year.

### Reminders & Telegram
- Renewal reminders on a schedule you set, delivered to Telegram.
- Connect once; toggle report delivery and reminders independently from Settings.

### Dashboard extras
- Live Claude usage widget (session + weekly gauges, per source), with manual-estimate fallback.
- YouTube Music player that docks inline on the dashboard and floats elsewhere, surviving navigation.
- Flip clock, light/dark theme toggle.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router, Fluid Compute / serverless) |
| UI | React 19, Tailwind CSS v4, custom design system, Recharts |
| State | TanStack Query (server), Zustand (UI), `next-themes` (theme) |
| Backend | Supabase (Postgres, Auth, Row-Level Security, Realtime) |
| Cloud / APIs | Google Cloud — YouTube Data API v3 (music search), Google OAuth 2.0 (Google sign-in identity) |
| Forms / validation | React Hook Form + Zod |
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
  (app)/            # authed shell — dashboard, subscriptions, reports
  api/              # route handlers (bridge mint/serve, usage ingest/live, YouTube)
  auth/callback, login
components/         # shared UI primitives + layout (app shell)
features/
  dashboard/        # claude-usage tracker, music player, connect-claude card
  subscriptions/    # calendar, list, statistics, category dock
lib/
  domain/           # pure money/date/renewal logic (the source of truth for figures)
  data/             # repository abstraction (mock ↔ supabase)
  supabase/         # server / client / admin(service-role) clients
  bridge/           # the downloadable usage-sharer script builder
supabase/migrations/# SQL migrations (applied to the live project)
```

A few things that matter when working in this codebase:
- **MYR-home.** All totals convert to Ringgit via `lib/domain/fx.ts`; round once after summing.
- **Civil dates.** Charge dates are calendar dates, parsed via `parseISODate` (not `new Date(iso)`) to avoid timezone off-by-one.
- **Renewal engine.** Charge series are derived from `startDate + billingCycle` in `lib/domain/renewal.ts` — that's what powers "what's charged this month."
- **Deterministic SSR.** "Now"-dependent values are computed server-side and passed down (e.g. `todayISO`) to prevent hydration mismatches.

See [CLAUDE.md](CLAUDE.md) for the full architectural guide.

---

## Broadcasting your Claude usage (Supabase mode)

1. Sign in (Google) and open the dashboard → **Share your Claude usage**.
2. **Windows:** click *Download my usage sharer*, unzip, run `START-HERE (Windows).bat`.
   **macOS:** switch the card to *macOS*, copy the one-line command, paste it into Terminal.
3. Keep the window open — your usage updates live on the dashboard (~every 30 s).

Want **both Claude Pro and GLM** live at once? Sign Claude Code into a dedicated config folder once (`CLAUDE_CONFIG_DIR=~/.claude-pro claude`, choose the Claude.ai subscription) — the sharer finds it automatically alongside your cc-switch GLM setup. See the in-app "Want both Claude Pro and GLM live at once?" guide.

Only usage percentages are sent — never credentials.

---

## License

This project is currently unlicensed / for personal and educational use. Add a `LICENSE` before public distribution if needed.
