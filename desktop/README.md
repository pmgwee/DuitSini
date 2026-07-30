# DuitSini Desktop

An Electron **shell** around the deployed DuitSini web app, plus the local
collectors that make AI-usage tracking work without the downloadable sharer.

Its whole reason to exist: today a member must download a ZIP, run a `.bat` (or
paste a command into Terminal), and **leave that window running** for the AI
Usage page to show anything. This app replaces that with "open the app".

## What this is NOT

Not a port. `desktop/` contains no copy of the web app, no pages, no components.
The window loads `APP_URL` directly, which is what makes every Vercel deploy show
up here with no rebuild — and why not one line of the web app changed.

Verify that claim at any time:

```bash
git diff main -- . ':!desktop'
```

Empty output means the web app is untouched.

## Architecture

```
main.ts          BrowserWindow → APP_URL; nav allow-list; tray; autostart
preload.ts       isolated world; exposes NOTHING to the page; mints the token
mint.ts          caches the cub_ token, re-mints only when rejected
scheduler.ts     per-source cadence, backoff, and the ingest push
store.ts         persisted cooldowns + calibration (userData/desktop-state.json)
net.ts           safeFetch: connection:close, 12s abort, 3 attempts
collectors/
  claude-oauth.ts   credential walk → api.anthropic.com/api/oauth/usage
  claude-refresh.ts gated on-demand refresh (v7 policy)
  claude-local.ts   zero-network estimate from ~/.claude/projects/*.jsonl
  glm.ts            cc-switch provider detect → gateway quota endpoint
```

The backoff ladders are **not** duplicated here — `tsconfig.json` compiles
`../lib/bridge/sharer/backoff.ts` directly so there is one source of truth. That
is why the emitted layout is `dist/desktop/src/*` and `dist/lib/*`.

## How usage reaches the dashboard

The app pushes to the **existing** `/api/claude-usage/ingest` with the same
`cub_` bearer and the same body shape the sharer sends. The server cannot tell
the two apart, which is deliberate:

- zero web-app changes, so nothing can regress;
- the multi-member dashboard and phone access keep working unchanged;
- the token remains the identity (a token is personal — never share one).

Minting runs in the preload because `/api/bridge/mac-command` is guarded by a
`Sec-Fetch-Site` check and the session cookie. A genuine same-origin fetch from
the signed-in document satisfies both with no header spoofing.

## The rate-limit story (read before changing `claude-refresh.ts`)

Two independent limiters have bitten this project:

| Limiter | Trigger | Handling here |
|---|---|---|
| Usage-endpoint 429 | Call **volume** on a rolling window keyed to the account | 300s cadence, quiet ladder `15→30→60m`, local estimate covers the gap |
| Token-endpoint 429 | **Refresh** POSTs retried in a loop | Refresh only at real expiry; ladder `15→30→60→120m`, persisted |

cc-switch never hits either because it never refreshes — `subscription.rs`:
*"第一层：仅读取凭据，不实现登录/刷新"* (layer 1: only reads credentials, does not
implement login/refresh). It reads the live `~/.claude` store that Claude Code
itself keeps fresh.

This app copies that as the **default path**, and only falls back to one gated
refresh when every candidate token is genuinely expired. That is the v7
on-demand policy — *not* v3's scheduled expiry−3h refresh, which is what
generated enough token-endpoint traffic to brick logins.

**Every gate degrades to using the current token.** `refreshIfNeeded` never
throws a cooldown at its caller; refresh is pure upside.

### If Claude usage shows nothing

Most likely your Claude Code is routed to a gateway (GLM etc.) via cc-switch, so
nothing on the machine keeps a Claude OAuth token fresh. Check:

```bash
node -e "const fs=require('fs');const p=process.env.USERPROFILE+'/.claude-pro/.credentials.json';const o=JSON.parse(fs.readFileSync(p,'utf8')).claudeAiOauth;console.log('expires',new Date(o.expiresAt).toISOString())"
```

If that is in the past and refresh returns 429, the login is flagged
server-side and **only a fresh browser sign-in clears it**:

```bash
CLAUDE_CONFIG_DIR=~/.claude-pro claude
```

then `/login`. On Windows PowerShell:

```bash
$env:CLAUDE_CONFIG_DIR="$HOME\.claude-pro"; claude
```

## Local estimate: what it can and cannot tell you

`claude-local.ts` aggregates `~/.claude/projects/*/*.jsonl` with zero network
calls, so it can never be rate-limited. Two honest limits:

1. `output_tokens` in those logs is a placeholder (1–2), not the real value —
   [anthropics/claude-code#25941](https://github.com/anthropics/claude-code/issues/25941).
   Input and cache fields are accurate.
2. It only sees Claude Code **on this machine** — not claude.ai in the browser,
   not Claude Desktop, not another computer.

So it has no honest denominator of its own and **reports `null` until
calibrated** against a real API reading rather than inventing a percentage.

It is also attributed to whichever provider Claude Code is *currently* routed
to: if cc-switch points Claude Code at GLM, those tokens are GLM traffic and
back the gateway stream, not the Claude subscription.

## Develop

```bash
pnpm install
pnpm dev
```

`desktop/` is its own pnpm root (see `pnpm-workspace.yaml`) so installing or
upgrading Electron can never perturb the Next.js build.

Point at a local server while developing:

```bash
DUITSINI_APP_URL=http://localhost:3000 pnpm dev
```

## Package

```bash
pnpm dist
```

Outputs to `release/`. Builds are **unsigned** — signing needs a paid
certificate — so first launch shows SmartScreen (Windows: More info → Run
anyway) or Gatekeeper (macOS: right-click → Open).

Icons are generated, not committed as opaque blobs:

```bash
node scripts/make-icons.mjs
```

## Required one-time setup: the OAuth redirect

Add these to **Supabase → Authentication → URL Configuration → Redirect URLs**:

```
http://127.0.0.1:43128/auth/callback
http://127.0.0.1:*/auth/callback
duitsini://auth/callback
```

The first is the **primary** loopback transport (see below); the second is a
glob that covers the rare case the fixed port is taken and the listener falls
back to an ephemeral one; the third is the `duitsini://` deep link kept as a
last-resort fallback. Without the matching entry, sign-in fails at the last hop
with `redirect_to is not allowed`. This is dashboard configuration, not code —
nothing in the web app changes.

The fixed port is `43128` by default and can be overridden with
`DUITSINI_LOOPBACK_PORT`.

## Google sign-in

Sign-in happens in the user's **real browser**, not in the app window. That is
the RFC 8252 ("OAuth 2.0 for Native Apps") recommendation and what Notion,
Spotify and Claude Desktop do. Google deliberately refuses to serve its consent
screen to an embedded webview — an earlier attempt to spoof a Chrome identity
was removed, because it fights an anti-abuse system that keeps tightening and it
hides the real URL bar at exactly the moment the user types a password.

The part that looks hard — "the browser has the session, the app doesn't" — is
avoided by intercepting one step earlier:

1. The user clicks **Continue with Google** in the app window, so the web app's
   own Supabase client writes its PKCE **code-verifier cookie into this app's
   cookie jar**.
2. It navigates to `…supabase.co/auth/v1/authorize?…`. We cancel that, rewrite
   **only** `redirect_to`, and open it in the system browser. `code_challenge`
   is left untouched — it must keep matching the verifier from step 1.
3. The user signs in to Google normally, in a real browser.
4. Supabase redirects to the rewritten `redirect_to` with `?code=…`. The app
   captures it and loads `<app>/auth/callback?code=…` in its window.
5. The web app's **existing** route exchanges the code against that verifier and
   sets the session.

So the browser never holds a session, this app never parses or writes an auth
cookie, and `app/auth/callback/route.ts` is used exactly as written.

### Why the code comes back over loopback HTTP, not the `duitsini://` deep link

Both are wired up. **Loopback is primary.** At startup the app binds a tiny
`http://127.0.0.1:43128` listener; step 2 rewrites `redirect_to` to
`http://127.0.0.1:43128/auth/callback`, so Supabase's terminal 302 targets a
*fetchable* URL. The browser just navigates to it (no external-protocol dialog,
no OS handler needed), the listener grabs `?code=`, shows a "you can close this
tab" page, and hands the code to the same completion path the deep link uses.

The custom-scheme `duitsini://` hand-off was the previous design, and it is
fragile in exactly the way that bit us: a server-issued 302 to a non-fetchable
scheme is routed through the browser's external-protocol dispatcher, which on
Windows Chrome is throttled for *server-redirect* triggers (not user clicks) and
demands a perfectly-registered, `URL Protocol`-marked handler. When it fails it
fails silently — the browser tab sits "loading" on Google's consent-summary page
forever and the app never receives the code. A loopback URL is a normal
navigation, so it never enters that path. Loopback is RFC 8252 §8.3's Best
Current Practice for native apps for exactly this reason.

`duitsini://` stays registered (hardened: remove-then-set, `app.getAppPath()`,
the `--` argv-injection guard, and the boolean return is now checked and logged)
as a fallback for the case the listener cannot bind.

### If sign-in still doesn't complete

The dev console now logs every hop, so the first missing line localizes the
break: `boot` → `protocol register … ok=true` → `loopback http://127.0.0.1:43128`
→ (click Continue with Google) → `OAuth → system browser: …` → `loopback
received (code=yes)` → `signed in → /subscriptions`.

- No `loopback received` line → Supabase did not redirect to the listener. Check
  the Redirect URLs entries above are exact and on the right project, and that
  the `redirect_to` in the logged system-browser URL is `http://127.0.0.1:43128/…`.
- `loopback received` then a **"Sign-in could not be completed"** dialog → the
  code reached the app but the server rejected the exchange (expired/replayed
  code, or the verifier cookie was cleared). Click Continue with Google again.
- To split custom-scheme registration from a Chrome throttle (only relevant if
  you fell back to `duitsini://`): with the app running, paste
  `duitsini://auth/callback?code=test` into Win+R. If it foregrounds the app,
  registration is fine and the problem is Chrome throttling the 302; if nothing
  happens, registration is the issue — see the `protocol register` boot log and
  `HKCU\Software\Classes\duitsini` in `regedit`.

## Known gaps

- Codex / Kimi collectors are not implemented yet; the collector interface is
  shaped for them.
- No auto-update feed is configured; `electron-updater` is wired but inert until
  a publish target exists.
- Builds are unsigned.
