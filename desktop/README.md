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

## Known gaps

- **Google OAuth** relies on presenting a clean Chrome user-agent
  (`chromeUserAgent()` in `main.ts`). If Google tightens beyond UA sniffing, the
  fallback is `shell.openExternal` + a `duitsini://` protocol handler, which
  needs that redirect added to Supabase's allow-list (dashboard config, not
  code).
- Codex / Kimi collectors are not implemented yet; the collector interface is
  shaped for them.
- No auto-update feed is configured; `electron-updater` is wired but inert until
  a publish target exists.
