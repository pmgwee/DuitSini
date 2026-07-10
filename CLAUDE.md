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
- `admin.ts` — **service role, bypasses RLS**. Only for trusted server paths (the bridge ingest, token minting, cross-user writes). Guarded by `isAdminConfigured()` (which also validates the URL via `new URL()` — a malformed/missing key returns false so it surfaces as a clean 503, not a mid-request 500). Created with `db: { timeout: 8000 }` so a stalled PostgREST call aborts in time for the route handler to return structured JSON instead of hanging until the platform kills the function (this was the root cause of the bridge's HTML-500 loops).

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
- Network resilience: the sharer's `safeFetch` sends `connection: close` (no stale undici keep-alive sockets reused after sleep/wake), retries 3×, and aborts each attempt at 12s. Genuine network/server errors retry in ~15s; usage/GLM 429s back off per-source (60s floor → 300s ladder, honoring `retry-after`). The ingest route sets `maxDuration = 20` and wraps the whole POST in try/catch so any throw/abort becomes structured JSON, never Next's HTML error page (which the bridge can't parse and used to surface as a 500).
- **v5 — cc-switch parity, auto-refresh DISABLED (current behavior):** `REFRESH_ENABLED = false` in the sharer template — the token-refresh endpoint is **never called** (even v3's discipline still hit refresh-429 lockouts on dedicated login dirs). Cloned from cc-switch's verified behavior: tokens are **server-authoritative** (used as-is even past their recorded `expiresAt`; only a real usage-endpoint 401/403 retires one), and on 401/403 the sharer **fails over across credential sources** (dedicated dirs → macOS Keychain `Claude Code-credentials` → `CLAUDE_CONFIG_DIR`/`~/.claude`), logging the active source whenever it changes. A 429 pauses the stream immediately (never multiplied across candidates). All-rejected → ~60s pause with a "sign in to Claude Code again" message; early resume only when a **fingerprint** of on-disk auth material changes (a rejected token that merely looks unexpired can't insta-resume-loop). **No `claude setup-token` path** (v5 removed the v3/v4 setup-token layer): such bearers lack the `user:profile` scope the usage endpoint requires and 403 on every plan (openclaw #4614) — only browser-login credentials can serve usage, so there is no refresh-free bearer (cc-switch has none either). Push cadence is member-configurable: `sharer-config.json` beside the script (`{"pushSeconds": N}`) or `CLAUDE_SHARER_PUSH_SECONDS`, clamped 60–3600s, default 60s (= cc-switch's own minimum interval). All v3 refresh machinery is kept intact in the template — flip `REFRESH_ENABLED` to restore it. **Owner decision:** the sharer stays a manually-run, visible window — never add auto-start/daemon/tray/hidden modes.
- Refresh discipline (v3 — dormant, kept for re-enable): Anthropic's token-refresh endpoint **flags a login that gets retried in a loop** (only a manual re-login clears it), so the sharer refreshes **early** (3h before the ~8h token expiry, per-token jitter), at most **once per escalating cooldown** (15m→30m→60m→120m on consecutive 429s, `retry-after` wins if longer), and **persists** the cooldown in `.sharer-state.json` next to the creds — restarts honor an in-progress wait instead of firing another attempt. Sources are isolated: a rate-limited Claude Pro never blocks the GLM push (per-source `nextAt`). An expired sign-in pauses only that stream and auto-resumes within one cycle when fresh creds appear on disk (member re-logs-in — no restart). *(The v3/v4 optional refresh-free `claude setup-token`/`CLAUDE_SHARER_TOKEN` bearer path was removed in v5 — those tokens lack the `user:profile` scope and 403 the usage endpoint; see the v5 bullet.)* Daily-rhythm hardening (6am wake → 3am sleep): a short randomized **settle window** after startup and after a detected sleep gap defers refresh POSTs only (a POST into a half-up network can lose the rotation response and strand the login); a refresh answered **4xx** (dead/rotated-away token) arms a persisted 60-min re-auth hold with a "sign in again" message instead of retrying every cycle (5xx holds 10 min); while all sources pause, the loop re-checks local creds ~every 15s so a re-login resumes near-instantly.

### App shell & feature layout
- `app/(app)/layout.tsx` wraps the authed shell in `MusicPlayerProvider` **before** `AppShell` so the YouTube IFrame player (and its audio) outlives navigation between app pages.
- `components/layout/app-shell.tsx` — sidebar (desktop) + sticky header + bottom nav (mobile) + floating `MiniPlayer`.
- `features/` — feature modules: `dashboard/` (claude-usage tracker, music player, connect-claude card, flip clock), `subscriptions/` (calendar, list, statistics, category dock, dialogs).
- `features/subscriptions/subscriptions-view.tsx` — the tabbed Page-1 surface (Calendar / All / Statistics). The `CategoryDock` only renders on Calendar + All (hidden on Statistics).
- Public landing page: `app/page.tsx` (root `/`, **outside** the `(app)` group — so no `MusicPlayerProvider`/`MiniPlayer`, by design). Full-screen background `<video>` via `components/hero-video.tsx`, a **client** component that imperatively sets `video.muted = true` + calls `play()` on mount and retries on the first pointer/touch/keydown. This is required because iPadOS Safari ignores React's `muted` attribute and blocks autoplay under Low Power Mode — **don't replace it with a bare inline `<video>`** or the iPad "stuck paused" bug returns.
- Music player volume persists per-user in `music_settings` via `app/api/yt/volume` (GET/PUT, default 50, RLS-pinned; degrades to 50 if the table is absent). `features/dashboard/music/use-yt-player.ts` loads it on mount, debounced-saves on change, and polls the iframe's `getVolume()`/`isMuted()` to mirror native-control changes back into state — so volume set via YouTube's own UI syncs to the mini-player across pages (no feedback loop).

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
