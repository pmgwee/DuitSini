# Bridge Sharer — Token-Refresh 429 Hardening (Implementation Plan)

> Audience: the implementing model (Sonnet 5). Standing user constraint: do NOT
> commit any work. Leave everything in the working tree. The user commits manually.
>
> Single file under change: `lib/bridge/member-bridge-template.ts`. The embedded
> `SOURCE` string must contain **no backticks, no `${}`, no backslashes** — it is
> embedded in a TS template literal and config is injected via `__PLACEHOLDER__`
> tokens. Validate this after every edit (see §7).

## 1. Incident forensics (log of 2026-07-09, mapped to code)

Timeline from the user's sharer log, cross-referenced with the current template:

| Time | Log event | Code path responsible |
|---|---|---|
| 13:26 | `[Claude Pro] usage sent` | Normal cycle. Access token minted at login ~13:25; Claude subscription access tokens live **~8 h**. |
| ~21:15 | Token enters the pre-expiry window | `EXPIRY_BUFFER_MS = 300000` (5 min) in `getToken()` — refresh attempts begin only **5 minutes** before expiry. |
| 21:20–21:24 | **4 refresh POSTs in ~4 min**, all 429 (`tokenAge=-5m … -1m`), each logged `couldn't refresh yet … using current sign-in` | `getToken()` gates refresh only by `REFRESH_MIN_MS = 45000` (45 s), which is shorter than the 60 s push cadence → a refresh attempt fires on **every** cycle inside the window. Worse: the push still succeeds on the old token, so `fetchAndPush` resets `backoff = 0` and `rateLimitStreak = 0` — refresh 429s during the runway apply **no backoff at all**. |
| 21:25:40 | `busy [Claude Pro] - waiting 120s` (`tokenAge=0m`) | Token now expired → the refresh 429 becomes fatal. No `retry-after`/`reset` header present (the log lines show neither), so the loop takes the ladder branch: 120 s → 240 s → **300 s cap**. |
| 21:25 → 00:24 | `waiting 300s` forever; ~36 more refresh POSTs over 3 h; GLM stream (healthy, 1%) **also stops** | Ladder cap `300000` = one refresh POST every 5 min, indefinitely. And in `fetchAndPush`, a Claude Pro 429 is re-thrown before the GLM block runs → the healthy GLM stream is killed by the unhealthy one. |
| (next day) | Only manual re-login recovers | Matches upstream reports: retry loops flag the OAuth grant into a **degraded state server-side**; a fresh login mints a new grant, which is why manual recovery works and waiting does not. |

Total refresh POSTs during the incident: **~40 in one evening**. A disciplined
client needs exactly **3 per day** (8 h token lifetime).

## 2. Root causes (ranked)

- **RC1 — Refresh runway is only 5 minutes.** `EXPIRY_BUFFER_MS = 300000`. One
  unlucky 429 five minutes before expiry leaves no room to cool down before the
  token dies. An 8 h token allows hours of runway; we use 0.06 of them.
- **RC2 — No dedicated refresh backoff.** Refresh attempts are throttled only by
  `REFRESH_MIN_MS = 45 s`. While the old token is still valid, refresh 429s are
  swallowed (`couldn't refresh yet`) and never feed any cooldown — the sharer
  hammered the token endpoint 4× in 4 minutes *while being told 429 each time*.
- **RC3 — Post-expiry retry cadence (300 s) sustains the lockout.** Upstream
  evidence (issue #38248, plus the degraded-grant reports) says repeated retries
  are what *keep* the grant flagged. Retrying every 5 minutes for hours is
  self-defeating; the correct shape is a few attempts with long escalating holds.
- **RC4 — One stream's 429 kills all streams.** In `fetchAndPush`, `throw e` on
  a Claude Pro 429 aborts the cycle before GLM is fetched; the dashboard loses
  the *healthy* stream too (visible in the log: GLM vanished at 21:25).
- **RC5 — All throttle state is in-memory.** `lastRefreshAt`, `backoff`,
  `rateLimitStreak` reset on restart → a human restarting the window fires an
  immediate refresh POST, extending the degraded state. The current "STOP
  RESTARTING" banner is a plea, not a defense.

Why did the *first* refresh attempt already 429? Not provable from the log, but
consistent hypotheses (plan handles all of them): the grant was still flagged
from a previous lockout burst; account/IP-level refresh budget shared with
Claude Desktop/CLI/browser on the same machine; or server-side tightening (seen
upstream with zero client change). Conclusion: **we must not assume any given
refresh will succeed** — wide runway + graceful degradation + a refresh-free
auth option are all required.

## 3. Research findings (2026-07-10)

- Claude subscription OAuth **access tokens live ~8 h**; the CLI stores a
  rotating refresh token. ([#31095](https://github.com/anthropics/claude-code/issues/31095),
  [#68398](https://github.com/anthropics/claude-code/issues/68398))
- The token endpoint 429s even ultra-conservative refreshers (1 call / 4 h);
  once flagged, only manual re-login recovers; issue closed "not planned" — no
  server-side fix coming. ([#38248](https://github.com/anthropics/claude-code/issues/38248))
- Retry loops against the refresh endpoint can put the grant into a degraded /
  flagged state that **outlasts normal rate-limit windows** — backing off harder
  is not just polite, it is the recovery mechanism.
  ([earendil-works/pi#4621](https://github.com/earendil-works/pi/issues/4621))
- The usage endpoint itself (`/api/oauth/usage`) is separately rate-limited and
  known to answer `retry-after: 0`. Already mitigated in-code (60 s floor).
  ([#30930](https://github.com/anthropics/claude-code/issues/30930),
  [#31021](https://github.com/anthropics/claude-code/issues/31021))
- **`claude setup-token`** mints a long-lived (`sk-ant-oat01-…`, ~1 year) token
  tied to the subscription, built for headless use (`CLAUDE_CODE_OAUTH_TOKEN`).
  If `/api/oauth/usage` accepts it as a Bearer, the sharer never needs the
  refresh endpoint again. **Unverified against the usage endpoint — spike first.**
  ([Claude Code docs — Authentication](https://code.claude.com/docs/en/authentication))

## 4. Decision (advisor call)

Two tracks, both worth doing; Track B ships regardless of Track A's outcome.

- **Track A — eliminate refresh entirely (preferred end-state).** Spike whether
  `/api/oauth/usage` accepts a `setup-token`. If yes, the sharer gains a
  refresh-free auth path: zero calls to the token endpoint for a year. This is
  the only design that *guarantees* "never hits the refresh 429 again".
- **Track B — make the refresh path survivable (ships now).** Even if Track A
  works, members will still run the OAuth-creds path (it's the default onboarding),
  and the sharer must never again convert one 429 into a dead night: refresh
  early with hours of runway, back off in long escalating holds, persist the
  cooldown across restarts, keep healthy streams flowing, and auto-adopt a
  manual re-login without a restart.

Honest limitation to record: with the OAuth-creds path, a server-side flag can
still deny refreshes no matter how polite we are (proven upstream at 1/4 h).
Track B turns that from "sharer dead + login bricked overnight" into "Claude Pro
stream pauses, GLM keeps flowing, and one `/login` on the member's machine
revives it within a cycle — no window restart". Track A removes the failure
class altogether.

## 5. Architecture decisions

All changes live inside `SOURCE` in `lib/bridge/member-bridge-template.ts`
unless stated. Keep the existing style: plain functions, no classes, ASCII only,
no backticks/`${}`/backslashes.

### D1 — Early, scheduled refresh (wide runway)
- New constants: `REFRESH_LEAD_MS = 10800000` (3 h) and `REFRESH_LEAD_JITTER_MS
  = 900000` (15 min).
- On each token check, compute `refreshDueAt = expiresAt - REFRESH_LEAD_MS +
  jitter` (jitter chosen once per token, persisted in the state file so cycles
  and restarts agree). Refresh when `now >= refreshDueAt`, not 5 min before death.
- With 8 h tokens this refreshes at ~5 h of age, leaving **~3 h of valid-token
  runway** to absorb 429 cooldowns.
- Guard: never refresh a token younger than 15 min (protects against a future
  `expires_in` shrink turning this into a hot loop).
- `EXPIRY_BUFFER_MS` (5 min) stays, but only as the "stop using this token"
  cutoff — not as the refresh trigger.

### D2 — Dedicated refresh cooldown, decoupled from the push loop
- New state: `refreshBlockedUntil`, `refreshStreak` (persisted, see D3).
- Any refresh 429 — **including while the old token is still valid** (the
  currently-swallowed case) — sets
  `refreshBlockedUntil = now + max(serverRetryMs, LADDER[refreshStreak])` with
  `LADDER = [15 min, 30 min, 60 min, 120 min]`, capped at 120 min, plus 0–3 min
  random jitter. A successful refresh resets the streak.
- At most **one refresh POST per cooldown window**, full stop. `getToken()` and
  the 401-retry path in `fetchAnthropicSnapshot()` both consult the same gate
  (today the 401 path only checks the 45 s `REFRESH_MIN_MS`).
- `REFRESH_MIN_MS` (45 s) remains only as an absolute anti-duplication floor
  between *successful* refreshes.
- Log the block with an **absolute clock time**: `refresh cooling down until
  10:42 pm (attempt 3)` — the current relative "waiting 300s" hid how long the
  night would be.

### D3 — Persist throttle state to disk (restart-proof)
- Sidecar file next to the creds file in use: `<credsDir>/.sharer-state.json`,
  shape: `{ refreshBlockedUntil, refreshStreak, lastRefreshAttemptAt,
  refreshJitterMs, updatedAt }`.
- Written atomically with the same unique-tmp + rename pattern as `writeCreds`.
  Unreadable/corrupt state file → treat as empty, never crash.
- Read on startup and **re-read before every refresh attempt** — this both
  survives restarts (kills RC5: restarting no longer fires an immediate POST)
  and acts as a best-effort cross-process throttle when two sharer instances
  share one creds file.
- Keep the "DO NOT restart" banner, but it now states the truth: "restart-safe;
  the cooldown is remembered".

### D4 — Per-stream isolation (GLM must survive a Claude Pro 429)
- Restructure `fetchAndPush` + `loop`: per-source state
  `src = { nextAttemptAt, backoffMs, streak }` for `claudePro` and `glm`.
- Each cycle, attempt every source whose `nextAttemptAt` has passed; push
  whatever succeeded (the ingest body already supports partial `streams`).
  A source-level 429 sets only that source's `nextAttemptAt` (server hint or
  the existing 60→300 s ladder for the usage/GLM endpoints; the *refresh*
  endpoint uses D2's much longer ladder) and never throws past the source loop.
- The global loop cadence stays `PUSH_MS` + jitter; the whole-loop `backoff`
  now applies only to dashboard-push failures and network-layer errors.
- Log lines stay per-source tagged; a busy source logs its next attempt time
  once, not every cycle.

### D5 — Expired-token graceful mode + zero-cost auto-recovery
- When the Claude Pro token is expired AND refresh is cooling down: do not
  throw, do not climb ladders. Log once per state change:
  `Claude Pro sign-in expired; next refresh attempt 11:15 pm; GLM continues.`
- Every cycle in this state, run the **adopt-from-disk check only** (a local
  file read — free, no network): if the member re-logs-in
  (`claude /login` with `CLAUDE_CONFIG_DIR` at the pro dir, or the setup .cmd),
  the sharer adopts the new creds within one cycle and resumes — **no restart,
  no window interaction**. This is the "manual recovery" path made automatic.
- Optional (nice-to-have): include a `notes` field in the push body listing
  paused sources so the dashboard can show "Claude Pro paused (sign-in expired)"
  instead of silently stale data. Server accepts unknown fields today; a
  dashboard rendering change is OUT of scope.

### D6 — Track A: setup-token auth path (behind the spike)
- Spike first (user runs it; 2 curl commands, §7 step 0). If the usage endpoint
  rejects `sk-ant-oat01` tokens, skip this decision entirely.
- If accepted: the sharer checks, before the OAuth-creds candidates, for a
  long-lived token via `CLAUDE_SHARER_TOKEN` env var or
  `~/.claude-pro/setup-token.txt` (single line, `sk-ant-oat01…`). When present:
  use it as the Bearer for `/api/oauth/usage`, and **skip getToken/refresh
  entirely** for the Claude Pro source. 401/403 on it → log "setup token
  rejected/revoked; falling back to sign-in creds" and fall through to the
  existing path.
- Onboarding doc line for members (README of the dashboard connect card, later):
  run `claude setup-token`, paste the token into `~/.claude-pro/setup-token.txt`.
- The token grants inference against the member's plan — treat the file exactly
  like `.credentials.json` (never leaves the machine; only percentages are sent).

### D8 — Startup/wake settle window (the 6am–3am daily pattern)
Members typically boot/wake ~6am and sleep the machine ~3am. Right after
startup or wake the network is often half-up; a refresh POST fired then can
succeed server-side (rotating the refresh token) while the response is lost —
stranding the sharer with a dead token. So: a short randomized settle window
(8–23 s at startup; 20–40 s after a detected sleep gap, via
`setTimeout`-lateness detection in the loop) defers **refresh POSTs only**.
Usage pushes are unaffected (safe to retry; refreshes are not). With 3 h of
refresh runway, a 40 s deferral costs nothing.

### D9 — Dead refresh token = re-auth pause, never a retry loop
A refresh answered with **4xx** (revoked token, or a rotation response lost in
transit) can never succeed by retrying — and per-cycle retries of a dead token
are another route back to endpoint hammering. It now arms a persisted 60 min
hold (`REAUTH_BLOCK_MS`) with an actionable message ("sign in again on this
computer — picked up automatically"), and the resume-on-fresh-creds watcher
revives the stream the moment a re-login lands. **5xx** (token service unwell)
holds 10 min. When all sources are pausing, the loop re-checks local state
every ~15 s (file reads only) so recovery is near-instant.

### D7 — Cosmetic/support hardening
- Bump `UA` from `claude-code/2.1.0` to a current CLI version string.
- Print a script version line in the startup banner (e.g. `sharer v3`) and log
  `refresh attempts today: N` alongside refreshes — makes future incident logs
  self-describing. Version constant lives in `SOURCE`; bump it on every behavior
  change so members' pasted logs identify stale scripts.

## 6. Execution order (To-do for Sonnet 5)

Every task ends with: `pnpm typecheck` green + the SOURCE-constraint check (§7).

| # | Task | Files | Acceptance |
|---|---|---|---|
| 0 | **[PENDING — USER, 5 min]** Spike: `claude setup-token` → curl `/api/oauth/usage` with it (§7 step 0). Record result here in this doc. | — | Documented yes/no. (Task 5 shipped anyway with silent fallback, so the spike now only tells us whether the refresh-free path *works*, not whether it's safe to ship.) |
| 1 | **[DONE 2026-07-10]** Refresh scheduler + cooldown ladder (D1 + D2) | `lib/bridge/member-bridge-template.ts` | ✅ Mock drill run A: refresh 429 with valid token → 1 POST, ~17 min persisted block, usage kept flowing |
| 2 | **[DONE 2026-07-10]** Persisted state sidecar (D3) | same file | ✅ Drill run B: restart during cooldown → 0 refresh POSTs, same absolute retry time |
| 3 | **[DONE 2026-07-10]** Per-stream isolation (D4) | same file | ✅ Structural (per-source `nextAt` gates); pro pause never aborts the loop (runs B/C) |
| 4 | **[DONE 2026-07-10]** Expired-token graceful mode + adopt-on-relogin (D5) | same file | ✅ Drill run C: paused with status log; fresh creds on disk resumed within one cycle, 0 POSTs. (Drill exposed + fixed a gap: `resumeOnFreshCreds` — sign-in-caused pauses end early on fresh creds; endpoint-busy pauses don't.) |
| 5 | **[DONE 2026-07-10]** setup-token path (D6): env/file detection, Bearer use, silent fallback | same file | ✅ Shipped; inert unless `setup-token.txt`/`CLAUDE_SHARER_TOKEN` present. End-to-end proof awaits spike (task 0) |
| 6 | **[DONE 2026-07-10]** UA bump (2.1.9) + v3 banner + daily refresh counter (D7) | same file | ✅ Banner prints "v3"; refresh log prints "(refresh N today)" |
| 7 | **[DONE 2026-07-10]** Verify end-to-end (§7) | — | ✅ typecheck, SOURCE-constraint check, `node --check`, drills A–D below. 24 h soak = user machine, pending |

### Implementation record (2026-07-10)

All changes in `lib/bridge/member-bridge-template.ts` only; nothing committed.
Behavioral drills ran against a local mock (no real Anthropic endpoint touched),
using a scratch creds dir via `CLAUDE_SUB_CONFIG_DIR`:

- **Run A (valid token, refresh due, endpoint 429s):** exactly 1 token POST
  across 2 push cycles (old code: 1 per cycle); cooldown persisted
  (`refreshBlockedUntil` ≈ +17 min); log shows absolute next-try time; usage
  kept flowing on the current sign-in.
- **Run B (restart, expired token, active cooldown):** 0 token POSTs; pause
  message reuses the persisted absolute time from the previous process.
- **Run C (re-login while paused):** fresh creds written to disk were adopted
  on the next cycle ("found a fresh Claude sign-in on disk - resuming now"),
  usage resumed, still 0 extra token POSTs.
- **Run D (happy-path refresh, endpoint 200):** 1 POST, creds rotated
  atomically (new access+refresh token, `expiresAt` +8 h), state reset
  (`refreshBlockedUntil: 0`, `refreshStreak: 0`, `lastRefreshOkAt` set),
  usage pushed with the fresh token.
- **Run A'' (429 + settle, after D8/D9):** cycle 1 pushed usage while the
  startup settle silently deferred the due refresh; cycle 2 made exactly 1
  POST → 429 → ~17 min persisted cooldown with absolute-time log; usage kept
  flowing.
- **Run E2 (dead refresh token, endpoint 400):** settle pause → exactly 1
  POST → 60 min persisted re-auth hold with actionable "sign in again"
  message → simulated re-login adopted at the next ~15 s check ("found a
  fresh Claude sign-in on disk - resuming now") → usage resumed. 1 token POST
  total; the old code would have retried the dead token every cycle.
- Incidental multi-instance proof: two sharer processes accidentally sharing
  one creds file coordinated correctly — the second saw `lastRefreshOkAt`
  seconds old in the state file, skipped its own refresh, and adopted the
  rotated creds from disk.

### The 6am–3am day, by the numbers (post-hardening)

- ~06:00 boot/wake: on-disk token expired overnight → settle window (≤40 s)
  → **refresh 1**. Fresh token good to ~14:00.
- ~11:00 (3 h lead, jittered): **refresh 2** → good to ~19:00.
- ~16:00: **refresh 3** → good to ~00:00.
- ~21:00: **refresh 4** → good to ~05:00 — covers sleep at 03:00.
- Worst case add **refresh 5** ~02:00. Total: 4–5 single, jittered POSTs per
  21-hour day (the incident night alone produced ~40). If any one attempt
  429s, the 3 h runway absorbs a full cooldown invisibly.

Remaining user actions: (1) 24 h soak on a real machine, (2) optional step-0
spike for the refresh-free path, (3) members re-download the sharer (v3 banner
identifies updated copies).

Out of scope: dashboard UI changes for paused-source notes; server/ingest
changes (none needed — `streams` is already partial-tolerant); the older
Anthropic-usage-endpoint 429 handling (already fixed, keep as-is); any change
outside the template file.

## 7. Tools & verification

**Step 0 — the spike (user action, needed before task 5 only):**

```powershell
claude setup-token   # prints sk-ant-oat01-... (1-year token, keep secret)
curl.exe -s -o NUL -w "%{http_code}" https://api.anthropic.com/api/oauth/usage -H "Authorization: Bearer sk-ant-oat01-REPLACE" -H "anthropic-beta: oauth-2025-04-20" -H "User-Agent: claude-code/2.1.0"
```

200 → Track A viable (task 5 goes ahead). 401/403 → skip task 5, Track B only.

**Per-edit checks:**
- `pnpm typecheck`
- SOURCE constraint (run from repo root; must print nothing):
  `Select-String -Path lib/bridge/member-bridge-template.ts -Pattern '[`]|\$\{' | Where-Object { $_.LineNumber -gt 24 -and $_.LineNumber -lt 419 }` — simpler: visually grep the SOURCE body for backtick, `${`, and `\` after every edit.
- Syntax-check the *generated* script: `pnpm dev`, sign in, download from the
  dashboard connect card (or GET `/api/bridge/download`), then
  `node --check claude-usage-sharer.mjs`.

**Behavioral tests (edit a downloaded copy of the .mjs, never the template):**
1. **Mock-429 drill:** point `TOKEN_ENDPOINTS` in the copy at a local mock
   (e.g. `npx http-echo` or a 10-line node server) returning 429 with no
   retry-after. Expect: one POST, then a 15 min block logged with absolute time;
   restart the script → **no new POST**; GLM lines continue throughout.
2. **Happy-path refresh:** in a scratch copy of the creds file, set `expiresAt`
   to now + 3.4 h → next cycle performs exactly one real refresh (this is the
   normal 3-per-day cadence) and writes rotated creds atomically.
3. **Re-login adoption:** with the mock still 429ing and the token expired,
   overwrite the scratch creds with fresh ones → sharer resumes within ~60 s
   without restart.
4. **24 h soak (user machine):** run overnight; success = zero `waiting 300s`
   lines, ≤4 refresh POSTs/day, GLM never gaps, and if a 429 occurs the log
   shows a long absolute-time hold instead of a ladder.

**Rollout note:** the sharer is generated per-member — after merging, each
member must re-download `claude-usage-sharer.mjs` from the dashboard. Old
running copies keep the old behavior; the version banner (D7) is how you tell
them apart in pasted logs.

## 8. Env / secrets

Nothing new server-side. `CLAUDE_SHARER_TOKEN` / `setup-token.txt` are
member-machine-only (Track A). No migrations, no dashboard env changes, no
`.env.example` changes required.
