/**
 * Builds the personalized `claude-usage-sharer.mjs` a group member downloads.
 * The script is self-contained (Node 20+ only), reads usage from THIS computer
 * and pushes the percentages to the dashboard authenticated by the member's
 * per-user bridge token.
 *
 * It can broadcast MORE THAN ONE usage stream at once:
 *   - Claude Pro/Max — from a Claude Code subscription login. Because Claude's
 *     5-hour/weekly limits are account-level and shared across Claude Code,
 *     Claude.ai, and Claude Desktop, any valid subscription OAuth token for the
 *     account returns the same usage. The token is read from the first
 *     candidate config dir that holds a subscription login (a dedicated dir
 *     like ~/.claude-pro keeps it stable even when cc-switch re-routes the
 *     main ~/.claude CLI).
 *   - GLM Coding — from a cc-switch-routed Claude Code CLI pointed at a
 *     z.ai/bigmodel gateway, using that provider's own key.
 * Whichever sources exist are fetched each cycle; each source schedules itself
 * independently, so a rate-limited source pauses alone while the others keep
 * flowing.
 *
 * v3 refresh discipline (the overnight-lockout fix): subscription access
 * tokens live ~8h and the token-refresh endpoint FLAGS a login that gets
 * retried in a loop — a 429 there used to brick the sign-in for a whole night.
 * The sharer now refreshes EARLY (3h before expiry, jittered), at most once
 * per escalating cooldown window (15m→30m→60m→120m), and persists the cooldown
 * in a `.sharer-state.json` next to the credentials so restarts can never fire
 * an extra attempt. (v3 also honored an optional long-lived token from
 * "claude setup-token" as a refresh-free usage bearer — later DISPROVEN and
 * removed in v5: such tokens lack the user:profile scope the usage endpoint
 * requires, so they 403 on every plan; only browser-login OAuth tokens work.)
 *
 * v5 — cc-switch parity (current behavior; verified against
 * farion1231/cc-switch's subscription service, which reads creds and never
 * refreshes). `REFRESH_ENABLED = false` disables ALL v3 refresh machinery
 * (kept intact below for a future re-enable — the token endpoint is never
 * called; even v3's discipline still hit refresh-429 lockouts on dedicated
 * login dirs):
 *   (1) SERVER-AUTHORITATIVE tokens: an on-disk access token is used AS-IS
 *       even past its recorded expiresAt — only a real 401/403 from the usage
 *       endpoint retires it (tokens often outlive the recorded expiry;
 *       cc-switch ships the same bet).
 *   (2) CANDIDATE FAILOVER: on 401/403 the sharer walks the next credential
 *       source (dedicated dirs → macOS Keychain → general dirs), logging the
 *       active source whenever it changes. A 429 pauses the stream
 *       immediately — never multiplied across candidates. All-rejected → a
 *       short pause with a "sign in again" message; a fingerprint of on-disk
 *       auth material gates early resume (a rejected token that merely LOOKS
 *       unexpired cannot insta-resume into the same 401).
 *   (3) macOS KEYCHAIN source: the "Claude Code-credentials" item, read like
 *       cc-switch does (newer CLIs on mac store creds only there).
 *   (4) CONFIGURABLE CADENCE: pushSeconds from a sharer-config.json beside
 *       the script (env CLAUDE_SHARER_PUSH_SECONDS wins), clamped 120–3600s.
 *   (5) NO SETUP-TOKEN PATH: "claude setup-token" bearers lack the
 *       user:profile scope this endpoint requires and 403 on every plan
 *       (openclaw #4614) — only browser-login credentials can serve usage,
 *       so v5 removed the v3/v4 setup-token layer entirely (cc-switch has no
 *       such path either).
 *
 * v6 — usage-429 budget hardening (2026-07-11). Three days of field data
 * (v3/v4/v5 all started ~1:30pm, all died ~7–8pm at 60s cadence — with AND
 * without refresh calls) showed the binding limit is a server-side rolling
 * volume/abuse window on the usage endpoint keyed to the ACCOUNT: ~330–390
 * calls/day tripped it, recovery came only after many hours of total silence
 * (overnight), and same-day retries at the old 300s-cap ladder kept the flag
 * warm. So v6:
 *   (1) DEFAULT CADENCE 300s (cc-switch's own default; 12 calls/h ≈ 192 calls
 *       over a 16h day — roughly half the observed trip band), floor 120s.
 *   (2) QUIET PERIODS, not fast retries, on a usage 429: 15m → 30m → 60m
 *       (retry-after wins if longer), and a changed on-disk login ends the
 *       pause early (so a deliberate /logout + fresh browser re-login can be
 *       tested as a recovery the moment it lands on disk).
 *   (3) MEASUREMENT: every network call to the usage endpoint is counted in a
 *       .sharer-usage-count.json beside the script (persists across restarts,
 *       resets at local midnight) and the count is printed on every push and
 *       on every 429 — so the next failure tells us whether the limit is
 *       count-based (dies near the same N) or time-based (dies near the same
 *       clock hours).
 *
 * v6.2 — self-reported cadence (2026-07-12). Each push now carries
 * push_seconds (the member's PUSH_MS) and sharer_version. The live route
 * derives its freshness window from push_seconds (2 cycles + grace) instead
 * of a hardcoded 3-minute constant that guaranteed a live→manual flap at the
 * 300s default cadence; sharer_version gives fleet visibility.
 *
 * v6.1 — identity echo (2026-07-12). The URL token IS the dashboard identity:
 * a member who ran a command copied from someone else's sign-in broadcast his
 * usage onto that other account. The startup banner now names the dashboard
 * account (email) the script pushes to — __ACCOUNT_EMAIL__, resolved from the
 * token's owner at download time — with a "not your account?" warning, and
 * /api/bridge/mac refuses tokens that are no longer registered (410).
 *
 * v7 — on-demand refresh at real expiry (2026-07-19). The first full day at
 * the 300s cadence (2026-07-18: 187 usage calls — half the 429 trip band, no
 * rate limit) exposed the OTHER limiter: the usage endpoint hard-rejects
 * (401) an access token the moment its ~8h expiresAt passes — the v5
 * "tokens outlive their recorded expiry" bet is dead — so with refresh
 * disabled every session died exactly 8h after login (death at 20:57, the
 * token's expiry minute) and needed a manual /logout + fresh browser
 * re-login. v7 re-enables the kept-intact refresh machinery in a strictly
 * ON-DEMAND mode: a token is still used AS-IS (v5 floor) until
 * EXPIRY_BUFFER_MS before its recorded expiry — or until a real usage 401
 * (force path) — and only then is ONE gated refresh spent; the settle
 * windows, 45s min gap, 15-min ok-gap, persisted cooldown ladder and 4xx
 * reauth hold all still apply, and every gate/failure DEGRADES to using the
 * current token (the candidate walk + all-rejected pause stay the
 * authority). Worst case equals v6 behavior (manual re-login); steady state
 * is ~3 refresh POSTs/day at 8h lifetimes — far below v3's early-refresh
 * schedule that produced the refresh-429 lockouts.
 *
 * IMPORTANT: the SOURCE below must contain NO backticks, no ${...}, and no
 * backslashes, so it embeds safely inside this template literal. Config is
 * injected via the __PLACEHOLDER__ tokens.
 */

const SOURCE = `#!/usr/bin/env node
/*
 * Claude Usage Sharer (personal, for the class dashboard).
 * Reads YOUR Claude usage from THIS computer and sends only the
 * percentages to the dashboard. Your login/password is never sent.
 * Close this window anytime to stop.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const SHARER_VERSION = "7";
const INGEST_URL = "__INGEST_URL__";
const PULL_URL = "__PULL_URL__";
// Which dashboard account this script broadcasts to. Baked in at download
// time from the token's owner - the URL token IS the identity, so a script
// copied from someone else pushes to THEIR account. The banner makes that
// visible so a member can catch it instantly. Empty when the server could
// not resolve it (self-hosted without admin creds); the banner line is
// skipped then.
const ACCOUNT_EMAIL = "__ACCOUNT_EMAIL__";
const BRIDGE_TOKEN = "__BRIDGE_TOKEN__";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_ENDPOINTS = ["https://platform.claude.com/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"];
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CC_SWITCH_DB = join(homedir(), ".cc-switch", "cc-switch.db");
const UA = "claude-code/2.1.9";
// PUSH_MS default is 300s (v6; was 60s in v5, 30s originally): the unofficial
// /api/oauth/usage endpoint is aggressively rate-limited (anthropics/
// claude-code issues #31637/#30930/#31021), and three days of field data
// showed a rolling per-ACCOUNT volume limit on top: polling at 60s died after
// ~330-390 calls (~6h), no matter whether tokens were refreshed or not, and
// recovered only after many hours of silence. 300s equals cc-switch's own
// DEFAULT auto-query interval - about 12 calls/h, roughly half the observed
// daily trip band even across a 16h day. The dashboard shows "last updated Xm
// ago", so a 5-minute gauge stays honest without looking offline.
// PUSH_JITTER_MS spreads the fixed cadence by +/- a few seconds so multiple
// instances (or several members) don't line up and hit the endpoint in lockstep.
// MIN_429_BACKOFF_MS is a floor: some 429s come back with retry-after: 0 (a
// documented footgun on this endpoint) - never retry faster than this, or a
// "0" would spin us straight back into the limit.
// PUSH_MS is configurable per member (cc-switch-style; see loadPushMs).
let PUSH_MS = 300000;
const PUSH_JITTER_MS = 8000, COMMAND_MS = 4000, MIN_GAP_MS = 9000, MIN_429_BACKOFF_MS = 60000;
// Token-refresh discipline (v7 - ON-DEMAND ONLY). Subscription access tokens
// live about 8 hours and the usage endpoint hard-rejects them (401) the
// moment the recorded expiresAt passes (proven 2026-07-18: a 187-call day at
// 300s cadence died at the exact expiry minute; only a fresh login revived
// it). The refresh endpoint, in turn, flags a login that gets hammered (the
// v3-era lockouts that once bricked a sign-in for a night). v7 threads the
// needle:
//   AS-IS FIRST - a token is used unchanged (v5/cc-switch parity) until
//     EXPIRY_BUFFER_MS before its recorded expiry, or until the server
//     answers a real 401. No early/scheduled refreshes, ever (v3's
//     early-at-expiry-minus-3h schedule is what generated enough token-
//     endpoint traffic to hit the refresh-429 lockouts).
//   ONE GATED ATTEMPT - a refresh POST is spent only when every guard
//     agrees: outside the persisted cooldown (.sharer-state.json beside the
//     creds - restarts and second instances honor an in-progress wait),
//     outside the post-boot/wake settle window, at least REFRESH_MIN_MS
//     since the last attempt, and at least REFRESH_MIN_OK_GAP_MS since a
//     SUCCESSFUL refresh (a fresh token that still 401s cannot be fixed by
//     refreshing harder).
//   DEGRADE, NEVER BLOCK - every gate and every failure falls back to using
//     the current token as-is; the usage endpoint stays the only authority
//     and the candidate walk / all-rejected pause handle the rest. Worst
//     case equals the old v5/v6 behavior (manual re-login); a working
//     refresh removes the 8-hour ceiling (~3 refresh POSTs/day at 8h
//     lifetimes).
const REFRESH_ENABLED = true;
const EXPIRY_BUFFER_MS = 300000, REFRESH_MIN_MS = 45000, REFRESH_MIN_OK_GAP_MS = 900000;
const REFRESH_COOLDOWNS_MS = [900000, 1800000, 3600000, 7200000];
// People run this from early morning (~6am boot/wake) to late night (~3am
// sleep). Right after startup or waking from sleep the network is often only
// half-up; a refresh POST fired then can succeed server-side (rotating the
// refresh token) while the response is lost - leaving us holding a dead token.
// So refresh attempts wait out a short settle window after start/wake; usage
// pushes are unaffected (they are safe to retry, refreshes are not).
// A refresh rejected with 4xx means the token is dead (revoked or rotated
// away) - retrying cannot fix it, only a re-login can, so it holds long and
// watches the disk for fresh credentials. 5xx = token service unwell; hold a
// modest window instead of fast-retrying.
const REAUTH_BLOCK_MS = 3600000, TOKEN_5XX_BLOCK_MS = 600000;

let lastFetchAt = 0, lastPullSeen = 0, lastRefreshAt = 0, lastWarn = "", backoff = 0, pushJitter = 0;
let refreshDayKey = "", refreshCountToday = 0;
let settleUntil = Date.now() + 8000 + Math.floor(Math.random() * 15000);
let lastTickAt = Date.now(), scheduledGap = 4000;
// Per-source scheduling: a rate-limited source pauses ITSELF (nextAt in the
// future) while every other source keeps flowing - one busy endpoint must
// never blank the whole dashboard again.
const sources = { pro: { nextAt: 0, backoff: 0, streak: 0, resumeOnFreshCreds: false, activeLabel: "", lastRejects: "", pausedFp: "" }, glm: { nextAt: 0, backoff: 0, streak: 0, resumeOnFreshCreds: false } };

const stamp = () => new Date().toLocaleTimeString();
function fmtClock(t) { return new Date(t).toLocaleTimeString(); }
function warnOnce(m) { if (m === lastWarn) return; lastWarn = m; console.warn("  " + stamp() + "  " + m); }
function noteRefresh() { const k = new Date().toDateString(); if (k !== refreshDayKey) { refreshDayKey = k; refreshCountToday = 0; } refreshCountToday++; return "refresh " + refreshCountToday; }

// How long the server told us to wait, from its rate-limit headers. retry-after
// is seconds; the reset header is an absolute unix time (seconds). Returns ms,
// or 0 if neither is usable. Honoring this is what stops a burst of refreshes
// from hammering the endpoint (which is what bricked the login for hours).
function retryMsFrom(ra, reset) {
  if (ra) { const s = parseInt(ra, 10); if (Number.isFinite(s) && s >= 0) return s * 1000; }
  if (reset) { const t = parseInt(reset, 10); if (Number.isFinite(t)) { const ms = t * 1000 - Date.now(); if (ms > 0) return ms; } }
  return 0;
}

// fetch() wrapper that fixes the recurring "fetch failed" after sleep/wake or a
// network change:
//   (a) sends "connection: close" so undici NEVER reuses a pooled socket. Node
//       pools keep-alive sockets per host; when the OS tears them down during
//       sleep/WiFi blips, the pool still holds them as "alive" and the next
//       cycle reuses a dead socket -> instant TypeError "fetch failed", which
//       undici does not reliably retry on. connection: close makes every fetch
//       open a fresh socket, so there is nothing stale to reuse.
//   (b) retries transient network-layer failures a few times (short delays) so
//       the brief window right after wake, where DNS/the stack isn't ready,
//       self-heals instead of surfacing as an error.
async function safeFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {}, { connection: "close" });
  let lastErr;
  for (let i = 0; i < 3; i++) {
    // Per-attempt deadline. A server that accepts the socket but never
    // responds (a function hanging until the platform kills it, or a stalled
    // gateway) would otherwise leave this fetch pending until the OS drops it
    // minutes later - which is what surfaced as a long "fetch failed". Aborting
    // at 12s lets the loop retry promptly and, failing that, report fast.
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 12000);
    try { const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); return r; }
    catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(function (r) { setTimeout(r, 1500 + i * 1500); });
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

// Candidate paths for a Claude Code SUBSCRIPTION login, most-specific first.
// The dedicated dirs (CLAUDE_SUB_CONFIG_DIR, ~/.claude-pro, ~/.claude-sub) keep
// a stable Pro/Max token even when cc-switch re-routes the main ~/.claude CLI
// to a gateway. The general CLAUDE_CONFIG_DIR / ~/.claude are a fallback so a
// member who only ever logged in normally still works.
function proCredsCandidates() {
  const home = homedir();
  const out = [];
  if (process.env.CLAUDE_SUB_CONFIG_DIR) out.push(join(process.env.CLAUDE_SUB_CONFIG_DIR, ".credentials.json"));
  out.push(join(home, ".claude-pro", ".credentials.json"));
  out.push(join(home, ".claude-sub", ".credentials.json"));
  if (process.env.CLAUDE_CONFIG_DIR) out.push(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"));
  out.push(join(home, ".claude", ".credentials.json"));
  return out;
}

// The OAuth blob inside a credentials JSON. Both key spellings occur in the
// wild (cc-switch parses both too).
function oauthEntryOf(creds) {
  if (!creds || typeof creds !== "object") return null;
  return creds.claudeAiOauth || creds["claude.ai_oauth"] || null;
}

// macOS Keychain source (darwin only): the same "Claude Code-credentials"
// item cc-switch reads - newer CLIs on mac store creds ONLY there. Missing
// entry / non-mac / any error resolves null (silent skip).
function readKeychainCreds() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise(function (resolve) {
    execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 4000 }, function (err, stdout) {
      if (err) return resolve(null);
      try { resolve(JSON.parse(String(stdout || "").trim())); } catch (e) { resolve(null); }
    });
  });
}

// v5 walk order: dedicated dirs first (a deliberate member choice), then the
// macOS Keychain, then the general fallbacks. Each source: { label, path,
// read() -> creds JSON or null }. Labels surface in logs so the member always
// knows WHICH login is feeding the dashboard.
function proCredSources() {
  const paths = proCredsCandidates();
  const fileSource = function (p) {
    return {
      label: p, path: p,
      read: async function () { try { return JSON.parse(await readFile(p, "utf8")); } catch (e) { return null; } },
    };
  };
  const out = [];
  // The general tail = CLAUDE_CONFIG_DIR (if set) + the plain ~/.claude;
  // everything before it is a dedicated dir. The keychain slots between.
  const tailStart = paths.length - (process.env.CLAUDE_CONFIG_DIR ? 2 : 1);
  for (let i = 0; i < tailStart; i++) out.push(fileSource(paths[i]));
  out.push({ label: "macOS Keychain", path: null, read: readKeychainCreds });
  for (let i = tailStart; i < paths.length; i++) out.push(fileSource(paths[i]));
  return out;
}

// Cheap identity of the auth material on disk (token tails only, never full
// secrets). Captured when the pro stream pauses on all-rejected; the stream
// resumes EARLY only when this CHANGES (a re-login, or a login moved into a
// new candidate dir) - never because a rejected token merely looks
// unexpired, which would resume straight back into the same 401 every few
// seconds. The keychain is deliberately excluded (spawning the security tool
// every tick is heavy); a keychain re-login is still picked up by the normal
// pause expiry (~60s).
async function credsFingerprint() {
  const parts = [];
  for (const p of proCredsCandidates()) {
    try {
      const o = oauthEntryOf(JSON.parse(await readFile(p, "utf8")));
      parts.push(o && o.accessToken ? String(o.accessToken).slice(-12) : "-");
    } catch (e) { parts.push("-"); }
  }
  return parts.join("|");
}

// v5: the script's own directory - sharer-config.json lives beside the script.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Effective push cadence: env CLAUDE_SHARER_PUSH_SECONDS wins, else
// {"pushSeconds": N} from a sharer-config.json beside this script, else 300s.
// Clamped to [120, 3600] (v6): the 3-day field data showed continuous 60s
// polling trips the account's rolling usage-endpoint limit after ~6h, so the
// fastest allowed setting is 120s - and the 300s default is the setting that
// clears a full 16h day with margin. Members who want a snappier gauge can
// set 120-180s, accepting they may hit the daily window on very long days.
async function loadPushMs() {
  let secs = null;
  const raw = (process.env.CLAUDE_SHARER_PUSH_SECONDS || "").trim();
  if (raw) { const n = parseInt(raw, 10); if (Number.isFinite(n)) secs = n; }
  if (secs == null) {
    try {
      const j = JSON.parse(await readFile(join(SCRIPT_DIR, "sharer-config.json"), "utf8"));
      if (j && typeof j.pushSeconds === "number" && Number.isFinite(j.pushSeconds)) secs = j.pushSeconds;
    } catch (e) { /* absent or corrupt config - keep the default silently */ }
  }
  if (secs == null) return 300000;
  return Math.min(3600, Math.max(120, Math.floor(secs))) * 1000;
}

// v6 MEASUREMENT LAYER: count every network call made to the Anthropic usage
// endpoint, persisted beside the script so restarts keep counting. This is
// what turns the NEXT rate-limit into a datapoint instead of a mystery:
//   - dies near the same CALL COUNT on different cadences -> count-based
//     budget (slow the cadence further);
//   - dies near the same CLOCK HOURS regardless of count -> time/session-
//     based (cadence won't fix it; the re-login experiment matters more).
// Resets at local midnight; survives restarts (a same-day restart must not
// hide calls already spent from the day's budget).
const USAGE_COUNT_FILE = join(SCRIPT_DIR, ".sharer-usage-count.json");
let usageCount = { day: "", count: 0, firstAt: 0 };
let usageCountLoaded = false;
async function loadUsageCount() {
  if (usageCountLoaded) return;
  usageCountLoaded = true;
  try {
    const j = JSON.parse(await readFile(USAGE_COUNT_FILE, "utf8"));
    if (j && j.day === new Date().toDateString() && typeof j.count === "number") {
      usageCount = { day: j.day, count: j.count, firstAt: typeof j.firstAt === "number" ? j.firstAt : 0 };
    }
  } catch (e) { /* first run or unreadable - start fresh */ }
}
async function noteUsageCall() {
  await loadUsageCount();
  const day = new Date().toDateString();
  if (usageCount.day !== day) usageCount = { day: day, count: 0, firstAt: 0 };
  usageCount.count++;
  if (!usageCount.firstAt) usageCount.firstAt = Date.now();
  const tmp = USAGE_COUNT_FILE + "." + process.pid + "." + Math.floor(Math.random() * 1e9) + ".tmp";
  try { await writeFile(tmp, JSON.stringify(Object.assign({}, usageCount, { lastAt: Date.now() }), null, 2), "utf8"); await rename(tmp, USAGE_COUNT_FILE); }
  catch (e) { /* counting is best-effort; never block a push */ }
}
function usageCallSummary() {
  if (!usageCount.count) return "no usage calls yet today";
  return usageCount.count + " usage calls today (since " + fmtClock(usageCount.firstAt) + ")";
}

async function writeCreds(path, creds) {
  // Unique temp name per process+call: if two instances ever write at the same
  // instant, a SHARED temp path would let them truncate/rename over each other
  // and corrupt the credentials file (bricking both -> re-login). A pid+random
  // suffix keeps each write isolated; rename is atomic, so readers see either
  // the old or new whole file, never a torn one.
  const tmp = path + "." + process.pid + "." + Math.floor(Math.random() * 1e9) + ".sharer.tmp";
  await writeFile(tmp, JSON.stringify(creds, null, 2), "utf8");
  await rename(tmp, path);
}

// Refresh throttle state, persisted next to the credentials file. Restarting
// the sharer (or running two copies against one login) re-reads this, so a
// cooldown already in progress is honored instead of reset. This is what makes
// restarts safe: the old behavior of "restart -> immediate refresh attempt" is
// exactly what kept a rate-limited login locked.
function stateFileFor(credsPath) { return join(dirname(credsPath), ".sharer-state.json"); }
async function readState(credsPath) {
  try { const s = JSON.parse(await readFile(stateFileFor(credsPath), "utf8")); return s && typeof s === "object" ? s : {}; }
  catch (e) { return {}; }
}
async function writeState(credsPath, patch) {
  const next = Object.assign({}, await readState(credsPath), patch, { updatedAt: Date.now() });
  const p = stateFileFor(credsPath);
  const tmp = p + "." + process.pid + "." + Math.floor(Math.random() * 1e9) + ".tmp";
  try { await writeFile(tmp, JSON.stringify(next, null, 2), "utf8"); await rename(tmp, p); }
  catch (e) { /* state is best-effort; never let it break a push */ }
  return next;
}

async function refresh(creds, path) {
  const o = oauthEntryOf(creds);
  const rt = o && o.refreshToken;
  if (!rt) throw new Error("Please open Claude Code and sign in first.");
  let lastErr;
  for (const url of TOKEN_ENDPOINTS) {
    let resp;
    try { resp = await safeFetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt, client_id: OAUTH_CLIENT_ID }) }); }
    catch (e) { lastErr = e; continue; }
    if (resp.status === 404) { lastErr = new Error("token endpoint 404"); continue; }
    if (resp.status === 429) {
      // Surface how long the endpoint wants us to wait, which creds file is
      // stuck, and how stale its token is (tokenAge > 0 => already expired) -
      // this is what tells us whether it's one file being hammered vs. a
      // genuinely long server-side limit.
      const ra = resp.headers.get("retry-after");
      const reset = resp.headers.get("anthropic-ratelimit-unified-reset");
      const exp2 = o.expiresAt;
      const ageMin = typeof exp2 === "number" ? Math.round((Date.now() - exp2) / 60000) : null;
      throw Object.assign(new Error("Anthropic token-refresh rate-limited (429) at " + url + (ra ? " retry-after=" + ra + "s" : "") + (reset ? " reset=" + reset : "") + " creds=" + path + (ageMin == null ? "" : " tokenAge=" + ageMin + "m")), { code: 429, retryMs: retryMsFrom(ra, reset) });
    }
    if (!resp.ok) {
      // 4xx: THIS refresh token is no longer accepted (revoked, or a rotation
      // response was lost in transit). Retrying can never fix that - only a
      // fresh login can - and blind per-cycle retries are exactly the
      // hammering that gets a login flagged. 5xx: the token service itself is
      // struggling; fast retries do not help either.
      const kind = resp.status < 500 ? "reauth" : "5xx";
      throw Object.assign(new Error("Could not refresh your sign-in (" + resp.status + ")."), { code: kind });
    }
    const j = await resp.json();
    if (!j.access_token) throw new Error("Refresh returned no token.");
    // Mutate the oauth entry IN PLACE inside the whole parsed credentials
    // file, then write the whole file back - sibling fields (mcpOAuth etc.)
    // and the key spelling ("claudeAiOauth" vs "claude.ai_oauth") survive.
    o.accessToken = j.access_token;
    if (j.refresh_token) o.refreshToken = j.refresh_token;
    o.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    await writeCreds(path, creds);
    console.log("  " + stamp() + "  refreshed your Claude sign-in (valid ~" + Math.max(1, Math.round((j.expires_in || 3600) / 3600)) + "h; " + noteRefresh() + " today)");
    return o.accessToken;
  }
  throw lastErr || new Error("Refresh failed.");
}

// Refresh de-duplication across restarts AND multiple instances that share one
// credentials file. The refresh endpoint ROTATES the refresh token on each
// success, so two processes (or a fresh restart with a cold in-memory timer)
// refreshing at once invalidate each other and stampede the endpoint into a
// 429 - the exact thing that bricked the login. Before spending a network
// refresh we: (1) wait a short random jitter so simultaneous starters desync;
// (2) re-read the file from disk - if a sibling already refreshed it (a newer,
// still-valid expiresAt than the token we came in with), ADOPT that token and
// skip the network entirely. Only if the disk token is still stale do we
// actually hit the endpoint.
async function refreshOrAdoptFromDisk(creds, path, staleExp) {
  await new Promise(function (r) { setTimeout(r, 200 + Math.floor(Math.random() * 800)); });
  try {
    const fresh = JSON.parse(await readFile(path, "utf8"));
    const fo = oauthEntryOf(fresh);
    if (fo && fo.accessToken && typeof fo.expiresAt === "number" && fo.expiresAt > staleExp && Date.now() < fo.expiresAt - EXPIRY_BUFFER_MS) {
      // A sibling/other login refreshed it while we waited - use their token
      // (the next cycle re-reads the file anyway; no write needed here).
      console.log("  " + stamp() + "  adopted a fresher sign-in from disk (another process refreshed it)");
      return fo.accessToken;
    }
    // Refresh with the newest refresh token on disk, not our possibly-rotated
    // in-memory one, so we never present a token a sibling already
    // invalidated - and refresh the FRESH file object, so the write-back
    // preserves whatever else the newest file holds.
    if (fo && fo.refreshToken) return await refresh(fresh, path);
  } catch (e) { /* unreadable/torn write - fall through to refresh what we have */ }
  return await refresh(creds, path);
}

// One cooldown-aware network refresh. Any 429 - INCLUDING while the old token
// is still valid (previously ignored, which let the pre-expiry window fire a
// refresh attempt every cycle) - arms an escalating hold in the state file;
// the next attempt waits it out instead of poking the endpoint again. Repeated
// pokes are what flag a login server-side and used to brick it for a night.
async function attemptRefresh(creds, path, staleExp) {
  await writeState(path, { lastRefreshAttemptAt: Date.now() });
  try {
    const token = await refreshOrAdoptFromDisk(creds, path, staleExp);
    await writeState(path, { refreshBlockedUntil: 0, refreshStreak: 0, lastRefreshOkAt: Date.now() });
    return token;
  } catch (e) {
    if (e && e.code === 429) {
      const st = await readState(path);
      const streak = (typeof st.refreshStreak === "number" ? st.refreshStreak : 0) + 1;
      const ladder = REFRESH_COOLDOWNS_MS[Math.min(streak, REFRESH_COOLDOWNS_MS.length) - 1];
      const hold = Math.max(e.retryMs || 0, ladder) + Math.floor(Math.random() * 180000);
      const until = Date.now() + hold;
      await writeState(path, { refreshStreak: streak, refreshBlockedUntil: until });
      e.blockedUntil = until;
    } else if (e && (e.code === "reauth" || e.code === "5xx")) {
      const until = Date.now() + (e.code === "reauth" ? REAUTH_BLOCK_MS : TOKEN_5XX_BLOCK_MS);
      await writeState(path, { refreshBlockedUntil: until });
      e.blockedUntil = until;
      if (e.code === "reauth") e.message = e.message + " Please sign in again on this computer (re-run the setup) - it is picked up automatically.";
    }
    throw e;
  }
}

// v7: decide whether to spend a refresh POST before this usage call. The
// token is used AS-IS (v5/cc-switch parity - the server is the authority)
// until its recorded expiry is actually upon us; force=true means a real 401
// just came back on this token, which overrides the clock. Every gate below
// DEGRADES to returning the current token instead of throwing: refresh here
// is pure upside, and the candidate walk / all-rejected pause in
// fetchProSnapshot remain the only failure authority.
async function getToken(creds, path, force) {
  const o = oauthEntryOf(creds);
  if (!o || !o.accessToken) throw new Error("Please sign in to Claude Code with your Claude Pro/Max account first.");
  if (!REFRESH_ENABLED || !o.refreshToken || !path) return o.accessToken;
  const now = Date.now(), exp = typeof o.expiresAt === "number" ? o.expiresAt : 0;
  // No early/scheduled refreshes, ever: v3's expiry-minus-3h schedule is what
  // generated enough token-endpoint traffic to trip refresh-429 lockouts.
  const usable = !force && now < exp - EXPIRY_BUFFER_MS;
  if (usable) return o.accessToken;
  const st = await readState(path);
  // A refresh that SUCCEEDED minutes ago and still yields 401s cannot be
  // fixed by refreshing harder - this gate (not bypassed by force) caps a
  // pathological loop at one refresh per REFRESH_MIN_OK_GAP_MS per source.
  const lastOk = typeof st.lastRefreshOkAt === "number" ? st.lastRefreshOkAt : 0;
  if (now - lastOk < REFRESH_MIN_OK_GAP_MS) return o.accessToken;
  const blockedUntil = typeof st.refreshBlockedUntil === "number" ? st.refreshBlockedUntil : 0;
  if (now < blockedUntil) return o.accessToken;
  // A refresh POST into a half-up network right after boot/wake can succeed
  // server-side (rotating the refresh token) while the response is lost -
  // stranding the login. Usage calls are safe to retry; refreshes are not.
  if (now < settleUntil) return o.accessToken;
  if (now - lastRefreshAt < REFRESH_MIN_MS) return o.accessToken;
  lastRefreshAt = now;
  try { return await attemptRefresh(creds, path, exp); }
  catch (e) {
    warnOnce("couldn't refresh the sign-in (" + ((e && e.message) || "error") + "); using the current one" + (e && e.blockedUntil ? "; next attempt " + fmtClock(e.blockedUntil) : ""));
    return o.accessToken;
  }
}

async function fetchUsage(token) {
  // Count the ATTEMPT (before knowing the outcome): the server's rolling
  // window sees every request, including ones that come back 401/403/429.
  await noteUsageCall();
  const r = await safeFetch(USAGE_ENDPOINT, { headers: { Authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": UA, "Content-Type": "application/json" } });
  if (r.status === 401) throw Object.assign(new Error("Sign-in rejected; will refresh."), { code: 401 });
  if (r.status === 429) {
    // Surface the retry-after / rate-limit headers Anthropic sends, so the log
    // shows WHY (and for how long) this endpoint is throttling us.
    const ra = r.headers.get("retry-after");
    const reset = r.headers.get("anthropic-ratelimit-unified-reset") || r.headers.get("x-ratelimit-reset");
    let detail = ""; try { detail = (await r.text()).slice(0, 160); } catch (e) { /* body may be empty */ }
    throw Object.assign(new Error("Anthropic usage rate-limited (429)" + (ra ? " retry-after=" + ra + "s" : "") + (reset ? " reset=" + reset : "") + (detail ? " body=" + detail : "")), { code: 429, retryMs: retryMsFrom(ra, reset) });
  }
  // 403 is coded like 401: for the v5 candidate walk both mean "this login
  // cannot serve usage" (revoked vs not-a-Pro-plan) - try the next source.
  if (r.status === 403) throw Object.assign(new Error("Usage is only available on a Claude Pro or Max plan (not a free plan or a different provider)."), { code: 403 });
  if (!r.ok) throw new Error("Usage check failed (" + r.status + ").");
  return r.json();
}

function pickWindow(w) { if (!w || typeof w.utilization !== "number") return null; return { utilization: w.utilization, resets_at: w.resets_at || null }; }

function normLimits(u) {
  if (!Array.isArray(u.limits)) return null;
  return u.limits.map(function (l) {
    let key, label;
    if (l.kind === "session") { key = "session"; label = "Current session"; }
    else if (l.kind === "weekly_all") { key = "weekly_all"; label = "All models"; }
    else if (l.kind === "weekly_scoped") { const m = (l.scope && l.scope.model && l.scope.model.display_name) || "Scoped"; key = "weekly:" + m; label = m; }
    else { key = l.kind || "unknown"; label = l.kind || "Unknown"; }
    return { key: key, label: label, group: l.group === "session" ? "session" : "weekly", percent: typeof l.percent === "number" ? l.percent : null, resets_at: l.resets_at || null, severity: l.severity || null };
  });
}

async function detectProvider() {
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(CC_SWITCH_DB, { readOnly: true });
    try {
      const row = db.prepare("select name, settings_config from providers where app_type = 'claude' and is_current = 1 limit 1").get();
      if (!row) return null;
      let env = {};
      try { const s = JSON.parse(row.settings_config || "{}"); env = (s && s.env) || {}; } catch (e) { /* keep name, skip env */ }
      const baseUrl = env.ANTHROPIC_BASE_URL || null;
      let official = true, host = null;
      if (baseUrl) { try { host = new URL(baseUrl).hostname; official = host === "anthropic.com" || host.endsWith(".anthropic.com"); } catch (e) { /* leave official true */ } }
      const isGlm = !!host && (host === "z.ai" || host.endsWith(".z.ai") || host.indexOf("bigmodel") !== -1);
      return {
        name: row.name || null, gateway_host: official ? null : host, official: official,
        source: official ? "anthropic" : (isGlm ? "zai" : "other"),
        authToken: env.ANTHROPIC_AUTH_TOKEN || null,
        monitorUrl: host ? "https://" + host + "/api/monitor/usage/quota/limit" : null,
      };
    } finally { db.close(); }
  } catch (e) { return null; }
}

// Public subset of a provider that is safe to send to the dashboard (no token).
function safeProvider(p) { return p ? { name: p.name, gateway_host: p.gateway_host, official: p.official } : null; }

function snapFromUsage(usage) {
  return { five_hour: pickWindow(usage.five_hour), seven_day: pickWindow(usage.seven_day), limits: normLimits(usage) };
}

// Remember which login currently feeds the dashboard and announce changes -
// with failover across several logins the member must always be able to see
// WHICH account's numbers they are looking at.
function noteActiveSource(label) {
  if (sources.pro.activeLabel === label) return;
  sources.pro.activeLabel = label;
  sources.pro.lastRejects = "";
  console.log("  " + stamp() + "  [Claude Pro] now using: " + label);
}

/**
 * Claude Pro snapshot - the v5 walk (cc-switch parity) + v7 on-demand
 * refresh. Each credential source (dedicated dirs -> macOS Keychain ->
 * general dirs) is tried in order. A token is used AS-IS until its recorded
 * expiry actually arrives (getToken refreshes it then, gated hard); the
 * server stays the authority:
 *   - 401      -> one force-gated refresh + single retry for a refresh-
 *                 capable file source; otherwise advance to the next source.
 *   - 403      -> this login can't serve usage; advance to the next source.
 *   - 429      -> STOP the walk (throttling is endpoint-level; trying more
 *                 candidates would multiply pressure) - pauseSource backs off.
 *   - network  -> STOP (safeFetch already retried; says nothing about tokens).
 *   - all-rejected -> short pause with a "sign in again" message; re-walked
 *                 ~1/min and resumed early only when the on-disk auth material
 *                 CHANGES.
 *
 * Note on setup-token (deliberately NOT used): a bearer from "claude
 * setup-token" lacks the user:profile scope this endpoint requires and 403s on
 * every plan (openclaw #4614) - only browser-login credentials can serve usage,
 * so there is no setup-token path here. cc-switch has none either.
 */
async function fetchProSnapshot() {
  let sawCreds = false;
  const rejects = [];
  for (const src of proCredSources()) {
    const creds = await src.read();
    const oauth = oauthEntryOf(creds);
    if (!oauth || !oauth.accessToken) continue;
    sawCreds = true;
    // v7: file sources go through getToken, which refreshes ON DEMAND (at
    // real expiry only) and otherwise returns the token as-is; the keychain
    // source is always as-is (nothing can write a rotation back to it).
    const token = (src.path && REFRESH_ENABLED)
      ? await getToken(creds, src.path)
      : oauth.accessToken;
    try {
      const snap = snapFromUsage(await fetchUsage(token));
      noteActiveSource(src.label);
      return snap;
    } catch (e) {
      if (e && (e.code === 401 || e.code === 403)) {
        // v7 reactive path: a 401 can mean the server retired this token
        // EARLIER than its recorded expiry. For a refresh-capable file
        // source, spend one force-gated refresh and retry usage ONCE with a
        // genuinely NEW token. All refresh guards still apply (cooldowns,
        // settle window, 15-min ok-gap), so a dead login costs at most one
        // refresh POST per hold window - never one per cycle.
        if (e.code === 401 && src.path && REFRESH_ENABLED && oauth.refreshToken) {
          let token2 = null;
          try { token2 = await getToken(creds, src.path, true); } catch (e2) { token2 = null; }
          if (token2 && token2 !== token) {
            try {
              const snap2 = snapFromUsage(await fetchUsage(token2));
              noteActiveSource(src.label);
              return snap2;
            } catch (e3) {
              if (!(e3 && (e3.code === 401 || e3.code === 403))) throw e3;
            }
          }
        }
        rejects.push(src.label + " (" + e.code + ")");
        continue;
      }
      throw e;
    }
  }
  if (!sawCreds) throw new Error("No Claude Pro sign-in found");
  // One line when the rejection set CHANGES - not one per cycle.
  const summary = rejects.join(", ");
  if (summary && summary !== sources.pro.lastRejects) {
    sources.pro.lastRejects = summary;
    console.warn("  " + stamp() + "  [Claude Pro] sign-in rejected on: " + summary);
  }
  throw Object.assign(new Error(
    "All found Claude sign-ins were rejected by the server. Please sign in to Claude Code with your Claude Pro/Max account again (or in a dedicated folder like ~/.claude-pro). A fresh login on this computer is picked up automatically."
  ), { code: "cooldown", until: Date.now() + 60000 });
}

// Fetch GLM Coding Plan usage from a z.ai/bigmodel gateway using the provider's
// own key (Authorization with NO Bearer prefix). unit=3/number=5 is the 5-hour
// window; unit=6/number=1 is the weekly window. TIME_LIMIT rows (MCP tools) are
// skipped. The key stays on this machine - only the percentages are sent.
async function fetchGlmUsage(provider) {
  const r = await safeFetch(provider.monitorUrl, { headers: { Authorization: provider.authToken, "Accept-Language": "en-US,en", "Content-Type": "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("Your GLM plan key was rejected (" + r.status + ").");
  if (r.status === 429) { const ra = r.headers.get("retry-after"); throw Object.assign(new Error("GLM provider rate-limited (429)" + (ra ? " retry-after=" + ra + "s" : "")), { code: 429, retryMs: retryMsFrom(ra, null) }); }
  if (!r.ok) throw new Error("GLM usage check failed (" + r.status + ").");
  const j = await r.json();
  const list = j && j.data && Array.isArray(j.data.limits) ? j.data.limits : [];
  let five = null, week = null;
  for (const l of list) {
    if (l.type !== "TOKENS_LIMIT") continue;
    const pct = typeof l.percentage === "number" ? l.percentage : null;
    const resets = typeof l.nextResetTime === "number" ? new Date(l.nextResetTime).toISOString() : null;
    if (l.unit === 3 && l.number === 5) five = { utilization: pct, resets_at: resets };
    else if (l.unit === 6 && l.number === 1) week = { utilization: pct, resets_at: resets };
  }
  const limits = [];
  if (five) limits.push({ key: "session", label: "Current session", group: "session", percent: five.utilization, resets_at: five.resets_at, severity: null });
  if (week) limits.push({ key: "weekly_all", label: "Weekly", group: "weekly", percent: week.utilization, resets_at: week.resets_at, severity: null });
  return { five_hour: five, seven_day: week, limits: limits.length ? limits : null };
}

// Push every gathered stream in ONE call. The legacy top-level fields mirror
// the primary stream (prefer a Claude-subscription source) so older servers
// that predate the streams array still record a snapshot.
async function pushStreams(streams) {
  const primary = streams.find(function (s) { return s.source === "claude_pro" || s.source === "claude"; }) || streams[0];
  const body = {
    five_hour: primary.five_hour, seven_day: primary.seven_day, limits: primary.limits, provider: primary.provider,
    streams: streams,
    // Self-described cadence: the dashboard derives its freshness window from
    // this (2 cycles + grace) instead of a hardcoded constant, so a member on
    // a custom pushSeconds never flaps between live and manual. The version
    // gives the owner fleet visibility (who still runs an old script).
    push_seconds: Math.round(PUSH_MS / 1000),
    sharer_version: SHARER_VERSION,
  };
  const r = await safeFetch(INGEST_URL, { method: "POST", headers: { Authorization: "Bearer " + BRIDGE_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text().catch(function () { return ""; }); throw new Error("Sending to dashboard failed (" + r.status + ")" + (t ? ": " + t.slice(0, 120) : "")); }
}

async function checkPull() {
  try { const r = await safeFetch(PULL_URL, { headers: { Authorization: "Bearer " + BRIDGE_TOKEN } }); if (!r.ok) return 0; const j = await r.json(); return j.pull_requested_at ? Date.parse(j.pull_requested_at) : 0; }
  catch { return 0; }
}

// A 429 or a refresh cooldown pauses ONLY this source until its window passes;
// anything else is a transient note, retried next cycle. Returns true when the
// error was handled as a pause.
function pauseSource(key, label, e) {
  const s = sources[key];
  const now = Date.now();
  // Sign-in-caused pauses (refresh cooldown / refresh 429 / dead refresh
  // token / token-service trouble) end early the moment fresh credentials
  // appear on disk; endpoint-busy pauses must not.
  s.resumeOnFreshCreds = !!(e && (e.code === "cooldown" || e.code === "reauth" || e.code === "5xx" || e.blockedUntil));
  if (e && (e.code === "cooldown" || e.code === "reauth" || e.code === "5xx")) {
    s.nextAt = (e.until || e.blockedUntil || now + MIN_429_BACKOFF_MS) + 2000;
    warnOnce("[" + label + "] paused - " + e.message + " Other sources keep updating.");
    return true;
  }
  if (e && e.code === 429) {
    s.streak++;
    if (e.blockedUntil) { s.nextAt = e.blockedUntil + 2000; }
    else if (key === "pro") {
      // v6: an Anthropic usage 429 is a rolling volume/abuse window on the
      // ACCOUNT (field data: ~330-390 calls tripped it, recovery needed hours
      // of silence, and the old 300s-cap ladder only kept the flag warm all
      // evening). So the answer is a real QUIET period - 15m, then 30m, then
      // 60m - with the server's retry-after winning when it asks for more.
      const quiet = [900000, 1800000, 3600000];
      const hold = Math.max(e.retryMs || 0, quiet[Math.min(s.streak, quiet.length) - 1]);
      s.nextAt = now + hold + Math.floor(Math.random() * 30000);
      // Log the day's call count AT the trip - the one number that tells us
      // whether the limit is count-based or time-based (see the counter note).
      console.warn("  " + stamp() + "  !!  [" + label + "] rate-limited after " + usageCallSummary() + " at " + Math.round(PUSH_MS / 1000) + "s cadence - write this down.");
      // A deliberate fresh re-login (/logout, then a full browser sign-in) is
      // the standing experiment for whether a new OAuth session clears the
      // flag - so let changed on-disk credentials end this pause early.
      s.resumeOnFreshCreds = true;
    }
    else if (e.retryMs && e.retryMs > 0) {
      // Honor the header, but never dip below the floor: this endpoint is
      // known to answer 429 with retry-after: 0, which would otherwise retry
      // instantly and re-trip the limit forever.
      s.nextAt = now + Math.min(600000, Math.max(MIN_429_BACKOFF_MS, e.retryMs + 3000 + Math.floor(Math.random() * 4000)));
    } else {
      s.backoff = Math.min(300000, Math.max(MIN_429_BACKOFF_MS, (s.backoff || PUSH_MS) * 2));
      s.nextAt = now + s.backoff;
    }
    warnOnce("busy [" + label + "] - " + (key === "pro" ? "quiet" : "next try") + " until " + fmtClock(s.nextAt) + "  (" + (e.message || "429") + ")");
    // After a few 429s in a row, reassure the human: the wait is persisted, so
    // neither leaving it open nor restarting can make it worse - it recovers
    // on its own. Reprinted every 3rd hit so it cannot scroll away unseen.
    if (s.streak === 3 || (s.streak > 3 && s.streak % 3 === 0)) {
      console.warn("");
      console.warn("  !!  Rate-limited " + s.streak + " times in a row on [" + label + "].");
      console.warn("      The sharer waits it out with long pauses and recovers on its own.");
      console.warn("      Other sources keep updating meanwhile. Restarting is safe (the");
      console.warn("      wait is remembered) but does not speed anything up.");
      console.warn("");
    }
    return true;
  }
  return false;
}

async function fetchAndPush(reason) {
  const now = Date.now();
  const provider = await detectProvider();
  const streams = [];
  const notes = [];
  // v5: a sign-in-caused pause ends early only when something auth-ish on
  // disk actually CHANGED (a re-login, or a login moved into a new folder).
  // Fingerprints, not expiry timestamps - a server-rejected token can look
  // unexpired, and a timestamp-based resume would walk straight back into the
  // same 401 every few seconds.
  if (now < sources.pro.nextAt && sources.pro.resumeOnFreshCreds) {
    const fp = await credsFingerprint();
    if (fp !== sources.pro.pausedFp) {
      sources.pro.nextAt = 0; sources.pro.resumeOnFreshCreds = false;
      console.log("  " + stamp() + "  found a changed Claude sign-in on disk - resuming now");
    }
  }
  if (now >= sources.pro.nextAt) {
    try {
      const snap = await fetchProSnapshot();
      streams.push({ source: "claude_pro", label: "Claude Pro", five_hour: snap.five_hour, seven_day: snap.seven_day, limits: snap.limits, provider: null });
      sources.pro.backoff = 0; sources.pro.streak = 0; sources.pro.nextAt = 0; sources.pro.resumeOnFreshCreds = false;
    } catch (e) {
      if (pauseSource("pro", "Claude Pro", e)) sources.pro.pausedFp = await credsFingerprint();
      else notes.push("Claude Pro: " + ((e && e.message) || "error"));
    }
  }
  if (provider && provider.source === "zai" && provider.authToken && now >= sources.glm.nextAt) {
    try {
      const snap = await fetchGlmUsage(provider);
      streams.push({ source: "glm", label: "GLM Coding", five_hour: snap.five_hour, seven_day: snap.seven_day, limits: snap.limits, provider: safeProvider(provider) });
      sources.glm.backoff = 0; sources.glm.streak = 0; sources.glm.nextAt = 0;
    } catch (e) { if (!pauseSource("glm", "GLM", e)) notes.push("GLM: " + ((e && e.message) || "error")); }
  }
  if (streams.length === 0) {
    // Nothing pushed this cycle. Check again soon (about 15s, not a full
    // cycle) so the end of a settle window or a fresh re-login on disk is
    // picked up quickly - these checks are local reads, no network cost.
    lastFetchAt = Date.now() - Math.max(0, PUSH_MS - 15000);
    if (notes.length) throw new Error("No usage sent. " + notes.join(" / "));
    return; // every configured source is pausing - already logged, stay quiet
  }
  await pushStreams(streams);
  lastFetchAt = Date.now(); lastWarn = "";
  for (const s of streams) {
    const f = s.five_hour && s.five_hour.utilization;
    const meter = s.source === "claude_pro" ? ", query " + usageCount.count + " today" : "";
    console.log("  " + stamp() + "  [" + s.label + "] usage sent to dashboard  (5-hour: " + (f == null ? "-" : f + "%") + meter + ")");
  }
  if (reason) console.log("  " + stamp() + "  [" + reason + "]");
}

async function loop() {
  // Sleep/wake detection: if this tick fired much later than scheduled, the
  // computer was asleep (the 3am-lid-close / 6am-lid-open pattern). Give the
  // network a short settle window before any refresh POST - firing one into a
  // half-up connection can lose the rotation response and strand the login.
  const tick = Date.now();
  if (tick - lastTickAt > scheduledGap + 90000) {
    settleUntil = tick + 20000 + Math.floor(Math.random() * 20000);
    console.log("  " + stamp() + "  woke from sleep - letting the connection settle before any sign-in refresh");
  }
  lastTickAt = tick;
  try {
    const pullTs = await checkPull();
    const pull = pullTs > lastPullSeen; if (pull) lastPullSeen = pullTs;
    const since = Date.now() - lastFetchAt;
    // Steady-state jitter: require PUSH_MS + a small random slice before each
    // scheduled push so several instances/members don't sync into a lockstep
    // burst on the shared usage endpoint. Re-rolled after each push. A user-
    // initiated pull bypasses it (still bounded by MIN_GAP_MS).
    if ((pull || since >= PUSH_MS + pushJitter) && since >= MIN_GAP_MS) {
      await fetchAndPush(pull ? "refresh requested" : "");
      backoff = 0; pushJitter = Math.floor(Math.random() * PUSH_JITTER_MS);
    }
  } catch (e) {
    // Only dashboard-push and setup problems land here now - each usage source
    // handles its own rate limits and pauses itself. Retry soon; these are
    // typically transient (sleep/wake, a network blip, a redeploy).
    backoff = 15000;
    warnOnce((e && e.message) || "fetch failed");
  } finally { scheduledGap = backoff || COMMAND_MS; setTimeout(loop, scheduledGap); }
}

(async function start() {
  PUSH_MS = await loadPushMs();
  await loadUsageCount();
  console.log("");
  console.log("  ============================================");
  console.log("   Claude Usage Sharer v" + SHARER_VERSION + " is running.");
  if (ACCOUNT_EMAIL) {
    console.log("   Broadcasting to dashboard account:");
    console.log("     >> " + ACCOUNT_EMAIL + " <<");
    console.log("   Not YOUR account? Close this window, sign in to the");
    console.log("   dashboard with YOUR Google account, and copy your own");
    console.log("   command there. Never reuse someone else's command.");
  }
  console.log("   Your usage now shows on the class dashboard, live.");
  console.log("   Keep this window open. Close it anytime to stop.");
  console.log("  ============================================");
  console.log("");
  console.log("  " + stamp() + "  update cadence: every " + Math.round(PUSH_MS / 1000) + "s  (change via sharer-config.json pushSeconds or CLAUDE_SHARER_PUSH_SECONDS, 120-3600)");
  console.log("  " + stamp() + "  usage-endpoint budget meter: " + usageCallSummary());
  console.log("  " + stamp() + "  reading your Claude Code sign-in(s) from disk (dedicated folders -> macOS Keychain -> ~/.claude).");
  console.log("  " + stamp() + "  expired sign-ins renew themselves now (v7 on-demand refresh) - no more 8-hour re-login.");
  console.log("  If sharing still stops later, sign in to Claude Code again - it is picked up automatically.");
  loop();
})();
`;

export function buildMemberBridge(cfg: {
  ingestUrl: string;
  pullUrl: string;
  token: string;
  /** Email of the token's owner, shown in the startup banner. "" hides it. */
  accountEmail: string;
}): string {
  // Whitelist-sanitize: the email lands inside a string literal in SOURCE,
  // which must stay free of backticks/backslashes/quotes. Real addresses only
  // use these characters anyway; anything else is dropped.
  const email = (cfg.accountEmail || "").replace(/[^A-Za-z0-9@._+-]/g, "");
  return SOURCE.split("__INGEST_URL__")
    .join(cfg.ingestUrl)
    .split("__PULL_URL__")
    .join(cfg.pullUrl)
    .split("__BRIDGE_TOKEN__")
    .join(cfg.token)
    .split("__ACCOUNT_EMAIL__")
    .join(email);
}
