# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm**. Scripts (`package.json`):

- `pnpm dev` — Next.js dev server on :3000
- `pnpm build` — production build (also runs ESLint + type generation)
- `pnpm start` — serve the production build
- `pnpm typecheck` — `tsc --noEmit` only (fast; run this after type-affecting edits)

There is **no test runner** configured. Linting happens inside `next build` (Next's built-in ESLint); there is no standalone `lint` script.

### Supabase
The live project is `ldsxmigqfgfcisweqckk` (region `ap-southeast-1`). Migrations live in `supabase/migrations/*.sql` and are **already applied** to the live DB (apply new ones via the Supabase MCP `apply_migration`, or `supabase db push`). After any schema change, regenerate `lib/supabase/types.ts` (Supabase MCP `generate_typescript_types`, or `supabase gen types typescript`) — the typed client depends on it.

## Data source switch (important)

`NEXT_PUBLIC_DATA_SOURCE` selects the backend (see `.env.example`):
- `mock` (default) — in-memory repo seeded from `lib/data/mock/seed.ts`. No Supabase needed. Works regardless of who's signed in (uses a fixed `DEMO_USER_ID`).
- `supabase` — real Postgres + Auth, scoped by `auth.uid()` (RLS).

Everything goes through `lib/data/index.ts`:
- `getSubscriptionRepository()` → returns either the Supabase-backed repo (bound to the request's auth cookies) or the mock. Both implement `SubscriptionRepository` (`lib/data/types.ts`).
- `getEffectiveUserId()` → real Supabra user id, or the demo id.

Never import the Supabase repo directly in a feature; call `getSubscriptionRepository()` so the mock path keeps working.

## Architecture

### Domain layer (`lib/domain/`) — pure, framework-agnostic
The financial/calendar correctness lives here and is reused by every surface:
- `renewal.ts` — the **charge-series engine**. Given an anchor date (start date, or trial-end if trialing) + `billingCycle` + `intervalCount`, it derives recurring charge dates. Everything about "when does this renew / what's charged this month" flows from this.
- `subscription.ts` — wraps the engine: `monthlyAmount` (normalized /mo), `chargeDatesInRange`, `subscriptionsChargingInRange`, `isActive`, `getNextChargeDate`.
- `money.ts` — `monthlyEquivalent`/`yearlyEquivalent` (billing-cycle normalization), `roundMoney`, currency formatters.
- `fx.ts` — **the app is MYR-home**: `toMYR(amount, currency)` converts any currency to ringgit for display/totals. Call sites convert per-sub then sum, rounding once.
- `dates.ts` — **civil dates** (YYYY-MM-DD), not instants. Always parse with `parseISODate` (local midnight); never `new Date("YYYY-MM-DD")` (UTC-midnight → local off-by-one). A fixed `en-GB` locale is used for formatting so Node and the browser agree (avoids hydration mismatches).
- `calendar.ts` — `monthBounds(year, month)` (0-indexed month), `calendarGrid` (Monday-start 42-cell).

**Money rule:** amounts are stored in major units (e.g. dollars, not cents). Convert each sub to MYR, sum at full precision, `roundMoney` once at the end.

### Two usage figures that are easy to confuse
- **Recurring (normalized /mo):** `monthlyAmount` — any billing cycle smoothed to a monthly figure (annual plan → 1/12 monthly).
- **This month (actual):** `subscriptionsChargingInRange` over the month's bounds — the real count + MYR of charges landing that month (annual subs only count in their renewal month; weekly subs can count multiple times).
These diverge for non-monthly cycles; the dock shows both side by side.

### Supabase clients (`lib/supabase/`)
- `server.ts` — cookie-bound, **RLS-enforced**. Use in route handlers + server components.
- `client.ts` — browser client (Realtime subscriptions, client fetches).
- `admin.ts` — **service role, bypasses RLS**. Only for trusted server paths (the bridge ingest, token minting, cross-user writes). Guarded by `isAdminConfigured()`.

### Auth + multi-tenancy
- Supabase Auth (Google OAuth). `middleware.ts` refreshes the session on every request, guards the `(app)` route group (redirects unsigned-in visitors to `/login`), and rescues stranded OAuth handoffs (`?code=` dropped on a non-callback route → forwarded to `/auth/callback`).
- RLS: each user reads only their own rows. The bridge pushes usage via the **service role** (it has no session cookie — it authenticates with a per-user bridge token instead).

### Claude usage bridge (distinctive feature)
Lets each member broadcast their Claude Pro / GLM usage live to the dashboard:
- `lib/bridge/member-bridge-template.ts` — builds the personalized `claude-usage-sharer.mjs` each member downloads/runs. **CRITICAL constraint:** the `SOURCE` string must contain NO backticks, NO `${}`, NO backslashes — it's embedded in a TS template literal. Config is injected via `__PLACEHOLDER__` tokens (`buildMemberBridge`).
- The script reads a Claude Pro OAuth token from a candidate list of config dirs (`~/.claude-pro`, `~/.claude-sub`, `CLAUDE_SUB_CONFIG_DIR`, then `~/.claude`) and GLM usage from cc-switch (`~/.cc-switch/cc-switch.db`), pushing **both** as a `streams` array.
- Auth model: `/api/bridge/mac-command` + `/api/bridge/download` **mint** a per-user token (authed by the Supabase session cookie + a `Sec-Fetch-Site` CSRF guard). `/api/bridge/mac?token=...` serves the script (token-in-URL, format-validated). `/api/claude-usage/ingest` resolves the user from the bearer token via `resolveBridgeUserId` (per-user token → `bridge_tokens`; legacy shared `CLAUDE_BRIDGE_SECRET` → pinned `CLAUDE_BRIDGE_USER_ID`).
- Token format: `cub_` + 48 hex chars (`BRIDGE_TOKEN_RE`). `bridge_tokens` allows **multiple tokens per user** (PK is a surrogate `id`); minting inserts + prunes oldest beyond 10, never deleting the just-inserted row.
- Live read: `/api/claude-usage/live` returns the latest snapshot + `streams`; the dashboard subscribes via Supabase Realtime (`use-claude-usage-live.ts`).

### App shell & feature layout
- `app/(app)/layout.tsx` wraps the authed shell in `MusicPlayerProvider` **before** `AppShell` so the YouTube IFrame player (and its audio) outlives navigation between app pages.
- `components/layout/app-shell.tsx` — sidebar (desktop) + sticky header + bottom nav (mobile) + floating `MiniPlayer`.
- `features/` — feature modules: `dashboard/` (claude-usage tracker, music player, connect-claude card, flip clock), `subscriptions/` (calendar, list, statistics, category dock, dialogs).
- `features/subscriptions/subscriptions-view.tsx` — the tabbed Page-1 surface (Calendar / All / Statistics). The `CategoryDock` only renders on Calendar + All (hidden on Statistics).

### Styling
Tailwind **v4** (CSS-first, `app/globals.css`). Design tokens are CSS variables consumed via Tailwind utilities and the `light-dark()` CSS function (theme-aware without per-mode duplication). Key custom classes: `glass`, `card-elevated`, category color tokens (`--cat-*`). Light/dark via `next-themes` (`app/providers.tsx`, class strategy).

### Deterministic SSR
Anything derived from "now" must be computed server-side and passed down to avoid hydration mismatches — e.g. the calendar receives `todayISO` from the server (`app/(app)/subscriptions/page.tsx`), not `new Date()` in client state.

## Conventions
- Money: store major units; convert to MYR per-sub, sum, round once.
- Dates: civil ISO; `parseISODate` only.
- New schema → migration in `supabase/migrations/` + regenerate `lib/supabase/types.ts`.
- Bridge template edits: no backticks/`${}`/backslashes in `SOURCE`.
- Interactive UI → `"use client"`; data fetch in server components or route handlers.
