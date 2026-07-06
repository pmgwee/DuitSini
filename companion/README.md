# Claude Usage Bridge (local companion)

A tiny **local** Node script that reads your Claude Code OAuth token and
**pushes** your real 5-hour / 7-day plan usage to your Subscription Agent site.
It is **not** part of the deployed app — it runs on your own machine.

```
┌── your machine ──────────────┐         ┌── Vercel (your site) ──────┐
│ Claude Code writes token to  │         │ POST /api/claude-usage/    │
│ ~/.claude/.credentials.json  │         │      ingest  (secret auth) │
│            │                 │  HTTPS  │        │                   │
│  bridge ───┼── reads token ──┼────────▶│   claude_usage_live (DB)   │
│  (this)    └── GET Anthropic │  push   │        │                   │
│            /api/oauth/usage  │         │  GET /api/claude-usage/    │
└──────────────────────────────┘         │      live → dashboard 53%  │
                                          └────────────────────────────┘
```

> **Personal use only.** It uses Anthropic's **unofficial** `/api/oauth/usage`
> endpoint (the same one Claude Code's `/usage` uses) and impersonates the
> Claude Code harness via the `User-Agent` header (required to avoid 429s).
> Using a subscription OAuth token outside Claude Code violates the letter of
> Anthropic's Consumer Terms — fine for reading your own usage on a hobby
> project, but it may break without notice. The token never leaves your machine;
> only the utilization %/reset times are sent.

## Why push (not poll)?

Your token lives only on your machine:

- **Windows:** `%USERPROFILE%\.claude\.credentials.json` (plaintext JSON)
- **Linux:** `~/.claude/.credentials.json` (perms `0600`)
- **macOS:** `~/.claude/.credentials.json` / Keychain

A deployed HTTPS site can't read that, and a browser on the deployed site can't
reliably reach `http://localhost` (mixed-content + Private Network Access
blocking). So the bridge pushes outward to the site, which stores the snapshot
and serves it same-origin. Works on your phone too.

## Setup

1. **Prereqs:** Node 20+ (you have 24). Log in with Claude Code at least once so
   the credentials file exists, and keep a `claude` session around occasionally
   so the token stays refreshed (access tokens expire ~hourly; Claude Code
   refreshes them while running).

2. **On the site (Vercel env vars),** add and redeploy:
   - `CLAUDE_BRIDGE_SECRET` — a long random string.
   - `CLAUDE_BRIDGE_USER_ID` — your Supabase user id (Dashboard → Authentication
     → Users). Pins writes to your account; recommended.
   - (`SUPABASE_SERVICE_ROLE_KEY` must already be set — the ingest route needs it.)

3. **Locally,** in this folder:
   ```bash
   cp .env.example .env
   # edit .env: INGEST_URL (your site), BRIDGE_SECRET (= the server's), CLAUDE_USER_ID
   node --env-file=.env claude-usage-bridge.mjs
   ```

You should see a line each cycle:
```
14:32:10  5h=53%  7d=5%  → pushed
```
Open the dashboard → **Claude usage** flips to the green **Live** badge within
~30s. Stop the bridge and it falls back to the manual estimate after 3 min.

## Configuration

| Var | Default | Notes |
| --- | --- | --- |
| `INGEST_URL` | — (required) | `https://<your-site>/api/claude-usage/ingest`. Use `http://localhost:3000/...` to test against local dev. |
| `BRIDGE_SECRET` | — (required) | Must equal the site's `CLAUDE_BRIDGE_SECRET`. |
| `CLAUDE_USER_ID` | — | Your Supabase user id. Optional if the server sets `CLAUDE_BRIDGE_USER_ID`. |
| `POLL_MS` | `60000` | Fetch+push interval. Clamped to ≥60s to respect Anthropic's rate limit; backs off on 429. |
| `CC_VERSION` | `2.1.0` | Version in `User-Agent: claude-code/<version>`. |
| `CLAUDE_CREDENTIALS_PATH` | auto | Override the credentials file path if non-standard. |

## Troubleshooting

- **`Token expired`** — run any `claude` command to refresh, then it recovers.
- **`Ingest returned 401`** — `BRIDGE_SECRET` ≠ server `CLAUDE_BRIDGE_SECRET`.
- **`Ingest returned 503`** — server missing `SUPABASE_SERVICE_ROLE_KEY` or `CLAUDE_BRIDGE_SECRET`.
- **`Ingest returned 400` (no target user)** — set `CLAUDE_USER_ID` here or `CLAUDE_BRIDGE_USER_ID` on the server.
- **Rate limited** — normal occasionally; the bridge backs off and recovers.
