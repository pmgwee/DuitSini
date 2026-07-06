# Claude Usage Bridge (local companion)

A tiny **local** Node service that reads your Claude Code OAuth token and proxies
the real 5-hour / 7-day plan usage to the dashboard. It is **not** part of the
deployed app — it runs on your own machine, bound to `127.0.0.1`.

> Personal use only. It uses Anthropic's **unofficial** `/api/oauth/usage`
> endpoint (the same one Claude Code's `/usage` uses). It impersonates the
> Claude Code harness via the `User-Agent` header (required to avoid 429s) and
> may break if Anthropic changes the endpoint or tightens client checks.

## Why a local process?

The OAuth token lives only on your machine:

- **Windows:** `%USERPROFILE%\.claude\.credentials.json` (plaintext JSON)
- **Linux:** `~/.claude/.credentials.json` (perms `0600`)
- **macOS:** Keychain (`Claude Code-credentials`)

This bridge reads `claudeAiOauth.accessToken` from there and calls the endpoint
server-side. A deployed app can never read your local token, so the dashboard
polls this bridge instead.

## Prerequisites

- Node.js 18+ (for global `fetch`).
- You must have logged in with **Claude Code** at least once on this machine so
  the credentials file exists (`claude` CLI → log in). Keep Claude Code's token
  fresh by running any `claude` command occasionally (access tokens expire
  ~hourly and Claude Code auto-refreshes them).

## Run

From this folder:

```bash
node claude-usage-bridge.mjs
```

It listens on `http://127.0.0.1:4785`. The dashboard auto-detects it and shows
the **Live (Claude Code)** view; if it isn't running, the dashboard falls back
to the manual estimate.

### Quick health check

```bash
curl http://127.0.0.1:4785/usage
```

Should return something like:

```json
{
  "five_hour": { "utilization": 34.0, "resets_at": "2026-07-06T14:00:00Z" },
  "seven_day": { "utilization": 66.0, "resets_at": "2026-07-12T18:00:00Z" },
  "refreshed_at": "2026-07-06T13:05:00.000Z"
}
```

If you see `"error": "token_expired"`, run a `claude` command in a terminal to
refresh the token, then retry.

## Configuration (env vars)

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` | `4785` | Port to listen on (also set `NEXT_PUBLIC_CLAUDE_USAGE_BRIDGE_URL` in the app to match). |
| `CC_VERSION` | `2.0.0` | The version in the `User-Agent: claude-code/<version>` header. Match your installed Claude Code version if you like. |
| `CACHE_TTL_MS` | `240000` (4 min) | How long a successful fetch is cached, to avoid 429 rate limits. |
| `ALLOWED_ORIGINS` | `http://localhost:3000,https://subscription-agent-five.vercel.app` | Comma-separated origins allowed by CORS. |

## Endpoints

- `GET /health` → `{ ok: true }`
- `GET /usage` → `{ five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at }, refreshed_at, cached? }` (or `{ error, message }`)

## Security

- Binds to **`127.0.0.1` only** — not reachable from the network/other devices.
- The token never leaves this process (never sent to the browser or Vercel).
  The dashboard only receives the computed percentages + reset times.
- CORS is restricted to your app origins.
