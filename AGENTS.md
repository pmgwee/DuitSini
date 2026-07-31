# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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

### Codex usage bridge (distinctive feature)
Lets each member broadcast their Codex Pro / GLM usage live to the dashboard:
- `lib/bridge/member-bridge-template.ts` — builds the personalized `Codex-usage-sharer.mjs` each member downloads/runs. **CRITICAL constraint:** the `SOURCE` string must contain NO backticks, NO `${}`, NO backslashes — it's embedded in a TS template literal. Config is injected via `__PLACEHOLDER__` tokens (`buildMemberBridge`).
- The script reads a Codex Pro OAuth token from a candidate list of config dirs (`~/.Codex-pro`, `~/.Codex-sub`, `CLAUDE_SUB_CONFIG_DIR`, then `~/.Codex`) and GLM usage from cc-switch (`~/.cc-switch/cc-switch.db`), pushing **both** as a `streams` array.
- Auth model: `/api/bridge/mac-command` + `/api/bridge/download` **mint** a per-user token (authed by the Supabase session cookie + a `Sec-Fetch-Site` CSRF guard). `/api/bridge/mac?token=...` serves the script (token-in-URL, format-validated **and DB-validated** — an unregistered/revoked token gets a 410, not a script). `/api/Codex-usage/ingest` resolves the user from the bearer token via `resolveBridgeUserId` (per-user token → `bridge_tokens`, stamping `last_used_at` on use; legacy shared `CLAUDE_BRIDGE_SECRET` → pinned `CLAUDE_BRIDGE_USER_ID`). **The token IS the identity:** every push lands on the token owner's row no matter whose browser/Google login is on the machine — commands/ZIPs are personal and must never be passed to another member (2026-07-12 incident: a member ran a command minted from the owner's session and broadcast onto the owner's account). v6.1 bakes the owner's email into the sharer's startup banner (`__ACCOUNT_EMAIL__`) and labels the dashboard card, so a copied command is caught on sight.
- Token format: `cub_` + 48 hex chars (`BRIDGE_TOKEN_RE`). `bridge_tokens` allows **multiple tokens per user** (PK is a surrogate `id`); minting inserts + prunes oldest beyond 10, never deleting the just-inserted row.
- Live read: `/api/Codex-usage/live` returns the latest snapshot + `streams`; the dashboard subscribes via Supabase Realtime (`use-Codex-usage-live.ts`), **filtered to the signed-in user's row**.
- **v6.2 — cadence self-report + pull throttle:** each push carries `push_seconds` + `sharer_version`; the live route derives its freshness window from the producer (`2 × clamp(push_seconds, 120, 3600) + 60s`; null → 300s default → 11 min) instead of a hardcoded constant — the old `FRESH_MS = 3 min` against the 300s cadence made the widget flap live→manual every cycle. `POST /api/Codex-usage/pull` enforces a **60s cooldown** (429 + `next_allowed_at`; the button mirrors it as a countdown) because every honored pull spends one call of the member's own Anthropic usage-endpoint budget (see v6). The sharer's `MIN_GAP_MS`/pause-respect stay as the last line of defense.
- Network resilience: the sharer's `safeFetch` sends `connection: close` (no stale undici keep-alive sockets reused after sleep/wake), retries 3×, and aborts each attempt at 12s. Genuine network/server errors retry in ~15s; a GLM 429 backs off per-source (60s floor → 300s ladder, honoring `retry-after`); a **Codex usage 429 takes a real quiet period** (15m → 30m → 60m, `retry-after` wins if longer — see the v6 bullet). The ingest route sets `maxDuration = 20` and wraps the whole POST in try/catch so any throw/abort becomes structured JSON, never Next's HTML error page (which the bridge can't parse and used to surface as a 500).
- **v5 — cc-switch parity (walk/failover still current; its refresh ban superseded by v7):** `REFRESH_ENABLED = false` in the sharer template — the token-refresh endpoint was **never called** (even v3's discipline still hit refresh-429 lockouts on dedicated login dirs). Cloned from cc-switch's verified behavior: tokens are **server-authoritative** (used as-is even past their recorded `expiresAt`; only a real usage-endpoint 401/403 retires one — *2026-07-18 field data killed the "outlive expiry" half of this bet; see v7*), and on 401/403 the sharer **fails over across credential sources** (dedicated dirs → macOS Keychain `Codex-credentials` → `CLAUDE_CONFIG_DIR`/`~/.Codex`), logging the active source whenever it changes. A 429 pauses the stream immediately (never multiplied across candidates). All-rejected → ~60s pause with a "sign in to Codex again" message; early resume only when a **fingerprint** of on-disk auth material changes (a rejected token that merely looks unexpired can't insta-resume-loop). **No `Codex setup-token` path** (v5 removed the v3/v4 setup-token layer): such bearers lack the `user:profile` scope the usage endpoint requires and 403 on every plan (openclaw #4614) — only browser-login credentials can serve usage, so there is no refresh-free bearer (cc-switch has none either). **Owner decision:** the sharer stays a manually-run, visible window — never add auto-start/daemon/tray/hidden modes.
- **v6 — usage-429 budget hardening (current cadence behavior, on top of v5):** 3 days of field data (2026-07-08→11) showed the binding limit is a **server-side rolling volume window on the usage endpoint keyed to the account** — ~330–390 calls/day at 60s cadence tripped a 429 regardless of refresh behavior (v5 makes zero refresh calls and died on the same ~6h clock as v3/v4), and recovery required hours of total silence (overnight), not a re-login or restart. So: push cadence default is now **300s** (cc-switch's own default; ~192 calls over a 16h day ≈ half the observed trip band), clamp **120–3600s** (`sharer-config.json` `{"pushSeconds": N}` or `CLAUDE_SHARER_PUSH_SECONDS`); a Codex usage 429 pauses that stream for a **quiet period** (15m → 30m → 60m by streak, `retry-after` wins if longer) instead of the old 300s-cap ladder that kept the flag warm, and sets `resumeOnFreshCreds` so a deliberate fresh re-login (`/logout` + browser sign-in) ends the pause early — that's the standing experiment for whether a new OAuth session clears the account flag. Every usage-endpoint call is **counted** in `.sharer-usage-count.json` beside the script (persists across restarts, resets at local midnight), printed on each push and on every 429 — the next trip's count tells us count-based vs time-based. Full incident journal + experiment protocol: `docs/sharer-usage-429-journal.md` (local, gitignored).
- **v7 — on-demand refresh at real expiry (current behavior, 2026-07-19):** the first full 300s-cadence day (2026-07-18: **187 calls — no 429**, proving v6's cadence fix) exposed a **second, independent limiter**: the usage endpoint hard-rejects (401) an access token the moment its **~8h `expiresAt`** passes — every session died exactly 8h after login and needed a manual `/logout` + fresh browser re-login (the refresh token sat unused on disk). So v7 sets `REFRESH_ENABLED = true` in a strictly **on-demand** mode: a token is used **as-is** (v5 floor) until 5 min before its recorded expiry — or until a real usage 401 (force path, one retry with a genuinely new token) — and only then spends **one** gated refresh POST (~3/day at 8h lifetimes). v3's **early/scheduled** refresh (expiry−3h + jitter — the volume that caused the refresh-429 lockouts) stays deleted (`REFRESH_LEAD_MS` removed). All guards persist in `.sharer-state.json`: post-boot/wake settle window, ≥45s between attempts, ≥15 min after any *successful* refresh (force can't bypass it — caps the fresh-token-still-401s loop), refresh-429 → 15m→30m→60m→120m ladder, refresh-4xx → 60-min reauth hold. **Every gate/failure degrades to using the current token** (`getToken` never throws cooldowns anymore) — worst case = the old v6 manual-re-login behavior, never worse. Credential write-back mutates the oauth entry **in place inside the whole parsed file** (sibling fields like `mcpOAuth` and both key spellings survive).
- Refresh discipline (v3 — early-schedule layer deleted in v7; these guards live on inside v7's on-demand mode): Anthropic's token-refresh endpoint **flags a login that gets retried in a loop** (only a manual re-login clears it), so the sharer refreshes **early** (3h before the ~8h token expiry, per-token jitter), at most **once per escalating cooldown** (15m→30m→60m→120m on consecutive 429s, `retry-after` wins if longer), and **persists** the cooldown in `.sharer-state.json` next to the creds — restarts honor an in-progress wait instead of firing another attempt. Sources are isolated: a rate-limited Codex Pro never blocks the GLM push (per-source `nextAt`). An expired sign-in pauses only that stream and auto-resumes within one cycle when fresh creds appear on disk (member re-logs-in — no restart). *(The v3/v4 optional refresh-free `Codex setup-token`/`CLAUDE_SHARER_TOKEN` bearer path was removed in v5 — those tokens lack the `user:profile` scope and 403 the usage endpoint; see the v5 bullet.)* Daily-rhythm hardening (6am wake → 3am sleep): a short randomized **settle window** after startup and after a detected sleep gap defers refresh POSTs only (a POST into a half-up network can lose the rotation response and strand the login); a refresh answered **4xx** (dead/rotated-away token) arms a persisted 60-min re-auth hold with a "sign in again" message instead of retrying every cycle (5xx holds 10 min); while all sources pause, the loop re-checks local creds ~every 15s so a re-login resumes near-instantly.

### App shell & feature layout
- `app/(app)/layout.tsx` wraps the authed shell in `MusicPlayerProvider` **before** `AppShell` so the YouTube IFrame player (and its audio) outlives navigation between app pages.
- `components/layout/app-shell.tsx` — sidebar (desktop) + sticky header + bottom nav (mobile) + floating `MiniPlayer`.
- `features/` — feature modules: `dashboard/` (Codex-usage tracker, music player, connect-Codex card, flip clock), `subscriptions/` (calendar, list, statistics, category dock, dialogs).
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

## Autopilot workflow (project skills)

The phase pipeline is automated by three project skills in `.Codex/skills/` (adapted from pinjun99/Sildenafil_coding, MIT — see `.Codex/skills/README.md`):
- `/phase-kickstart` — requirements interrogation (user must be present) → `docs/charter/PROJECT-CHARTER.md` → a `handoff/` plan (manifest · contracts · briefs · STATE journal).
- `/phase-autopilot` — unattended loop: GLM executes each brief headless via `scripts/autopilot/glm-run.mjs` (provider env read per-process from cc-switch — never switches it globally; `--loop N` chains briefs into batches) and captures its own UI evidence per the brief's UAT NOTES into `handoff/evidence/`; the top-tier session vets diffs, re-runs verification, reviews the evidence, rules on deviations (`ADVISOR.md`), and runs the final review (the one full hands-on browser pass) itself.
- `/uat-runbook` — every human-facing testing/setup doc uses the house format (`.Codex/skills/uat-runbook/references/TEMPLATE.md`).

If `handoff/00-MANIFEST.md` exists (first line `handoff-plan v1`), a plan is live: resume by reading its `NEXT:` line and following phase-autopilot. `/docs` and `/handoff` are gitignored on purpose — plans, charters and runbooks stay local; commits carry code only (message convention `handoff: brief NN <state>`).

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`github.com/pmgwee/subscription-agent`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context — one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
