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
 * an extra attempt. An optional long-lived token (from `claude setup-token`,
 * placed in `setup-token.txt` or CLAUDE_SHARER_TOKEN) skips the refresh
 * endpoint entirely; absent it, the normal sign-in flow needs no extra setup.
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

const SHARER_VERSION = "3";
const INGEST_URL = "__INGEST_URL__";
const PULL_URL = "__PULL_URL__";
const BRIDGE_TOKEN = "__BRIDGE_TOKEN__";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_ENDPOINTS = ["https://platform.claude.com/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"];
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CC_SWITCH_DB = join(homedir(), ".cc-switch", "cc-switch.db");
const UA = "claude-code/2.1.9";
// PUSH_MS is 60s (was 30s): the unofficial /api/oauth/usage endpoint is
// aggressively rate-limited and third-party pollers at 30s reliably trip a
// session-long 429 (anthropics/claude-code issues #31637/#30930/#31021). 60s
// keeps us comfortably under that trigger while the dashboard still feels live.
// PUSH_JITTER_MS spreads the fixed cadence by +/- a few seconds so multiple
// instances (or several members) don't line up and hit the endpoint in lockstep.
// MIN_429_BACKOFF_MS is a floor: some 429s come back with retry-after: 0 (a
// documented footgun on this endpoint) - never retry faster than this, or a
// "0" would spin us straight back into the limit.
const PUSH_MS = 60000, PUSH_JITTER_MS = 8000, COMMAND_MS = 4000, MIN_GAP_MS = 9000, MIN_429_BACKOFF_MS = 60000;
// Token-refresh discipline. Subscription access tokens live about 8 hours,
// and the refresh endpoint flags a login that gets retried in a loop (that
// flag is what bricked the sign-in for a whole night). So refreshes are:
//   EARLY - scheduled REFRESH_LEAD_MS before expiry (minus a per-token random
//     offset so members never line up), leaving hours of valid-token runway
//     to wait out a cooldown if an attempt gets rate-limited;
//   RARE - one network attempt per cooldown window, escalating through
//     REFRESH_COOLDOWNS_MS on consecutive 429s (server retry-after wins if
//     longer). A normal day needs only ~3 refreshes total;
//   REMEMBERED - the cooldown lives in .sharer-state.json next to the creds,
//     so restarting the window (or a second instance) honors an in-progress
//     wait instead of resetting it and firing another attempt.
// EXPIRY_BUFFER_MS is only the "stop using this token" cutoff, no longer the
// refresh trigger. REFRESH_MIN_OK_GAP_MS stops a hot loop if token lifetimes
// ever shrink below the lead time.
const EXPIRY_BUFFER_MS = 300000, REFRESH_MIN_MS = 45000;
const REFRESH_LEAD_MS = 10800000, REFRESH_LEAD_JITTER_MS = 900000, REFRESH_MIN_OK_GAP_MS = 900000;
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
const sources = { pro: { nextAt: 0, backoff: 0, streak: 0, resumeOnFreshCreds: false }, glm: { nextAt: 0, backoff: 0, streak: 0, resumeOnFreshCreds: false } };

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

// First candidate creds file that holds a usable Claude subscription OAuth
// token. Returns { path, creds } or null. Re-read from disk every cycle, so a
// member who re-logs-in after an expiry is picked up automatically within a
// cycle - no restart needed.
async function findProCreds() {
  for (const p of proCredsCandidates()) {
    let creds;
    try { creds = JSON.parse(await readFile(p, "utf8")); }
    catch (e) { continue; }
    const o = creds.claudeAiOauth;
    if (o && o.accessToken && o.refreshToken) return { path: p, creds: creds };
  }
  return null;
}

// Optional long-lived token path (power users / troubleshooting): a token from
// "claude setup-token" placed in setup-token.txt next to any candidate creds
// file, or in CLAUDE_SHARER_TOKEN. When present, usage is fetched with it
// directly and the refresh endpoint is NEVER called. Absent for most members -
// the normal sign-in flow needs no extra setup.
async function findSetupToken() {
  const fromEnv = (process.env.CLAUDE_SHARER_TOKEN || "").trim();
  if (fromEnv.indexOf("sk-ant-") === 0) return fromEnv;
  for (const credsPath of proCredsCandidates()) {
    try {
      const t = (await readFile(join(dirname(credsPath), "setup-token.txt"), "utf8")).trim();
      if (t.indexOf("sk-ant-") === 0) return t;
    } catch (e) { /* not there - normal */ }
  }
  return null;
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
  const rt = creds.claudeAiOauth && creds.claudeAiOauth.refreshToken;
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
      const exp2 = creds.claudeAiOauth && creds.claudeAiOauth.expiresAt;
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
    creds.claudeAiOauth.accessToken = j.access_token;
    if (j.refresh_token) creds.claudeAiOauth.refreshToken = j.refresh_token;
    creds.claudeAiOauth.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    await writeCreds(path, creds);
    console.log("  " + stamp() + "  refreshed your Claude sign-in (" + noteRefresh() + " today)");
    return creds.claudeAiOauth.accessToken;
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
    const fo = fresh.claudeAiOauth;
    if (fo && fo.accessToken && typeof fo.expiresAt === "number" && fo.expiresAt > staleExp && Date.now() < fo.expiresAt - EXPIRY_BUFFER_MS) {
      // A sibling/other login refreshed it while we waited - use their token.
      creds.claudeAiOauth = fo;
      console.log("  " + stamp() + "  adopted a fresher sign-in from disk (another process refreshed it)");
      return fo.accessToken;
    }
    // Refresh with the newest refresh token on disk, not our possibly-rotated
    // in-memory one, so we never present a token a sibling already invalidated.
    if (fo && fo.refreshToken) creds.claudeAiOauth = fo;
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

// Decides whether the current access token is fine, a refresh is due, or we
// are inside a cooldown. Refreshes are scheduled REFRESH_LEAD_MS before expiry
// (with a per-token random offset, remembered in the state file so cycles and
// restarts agree), so a rate-limited attempt still has hours of runway on the
// still-valid token. A cooldown error carries code "cooldown" so the caller
// pauses this source quietly instead of climbing any backoff ladder.
async function getToken(creds, path) {
  const o = creds.claudeAiOauth;
  if (!o || !o.accessToken || !o.refreshToken) throw new Error("Please sign in to Claude Code with your Claude Pro/Max account first.");
  const now = Date.now(), exp = typeof o.expiresAt === "number" ? o.expiresAt : 0;
  const usable = now < exp - EXPIRY_BUFFER_MS;
  const st = await readState(path);
  let lead = (st.jitterForExp === exp && typeof st.jitterMs === "number") ? st.jitterMs : -1;
  if (lead < 0) { lead = Math.floor(Math.random() * REFRESH_LEAD_JITTER_MS); await writeState(path, { jitterForExp: exp, jitterMs: lead }); }
  const lastOk = typeof st.lastRefreshOkAt === "number" ? st.lastRefreshOkAt : 0;
  const due = now >= exp - REFRESH_LEAD_MS + lead && now - lastOk >= REFRESH_MIN_OK_GAP_MS;
  if (usable && !due) return o.accessToken;
  const blockedUntil = typeof st.refreshBlockedUntil === "number" ? st.refreshBlockedUntil : 0;
  if (now < blockedUntil) {
    if (usable) return o.accessToken;
    throw Object.assign(new Error("Claude sign-in expired; next refresh attempt " + fmtClock(blockedUntil) + ". A re-login on this computer is picked up automatically."), { code: "cooldown", until: blockedUntil });
  }
  if (now < settleUntil) {
    if (usable) return o.accessToken;
    throw Object.assign(new Error("letting the connection settle after startup/wake before refreshing the sign-in"), { code: "cooldown", until: settleUntil });
  }
  if (now - lastRefreshAt < REFRESH_MIN_MS) {
    if (usable) return o.accessToken;
    throw Object.assign(new Error("waiting a moment before the next refresh"), { code: "cooldown", until: lastRefreshAt + REFRESH_MIN_MS });
  }
  lastRefreshAt = now;
  try { return await attemptRefresh(creds, path, exp); }
  catch (e) {
    if (usable) {
      warnOnce("couldn't refresh yet (" + ((e && e.message) || "error") + "); using current sign-in" + (e && e.blockedUntil ? "; next try " + fmtClock(e.blockedUntil) : ""));
      return o.accessToken;
    }
    throw e;
  }
}

async function fetchUsage(token) {
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
  if (r.status === 403) throw new Error("Usage is only available on a Claude Pro or Max plan (not a free plan or a different provider).");
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

async function fetchAnthropicSnapshot(creds, path) {
  let token = await getToken(creds, path), usage;
  try { usage = await fetchUsage(token); }
  catch (e) {
    if (e.code === 401) {
      // The server rejected a token we thought was valid - treat it as expired
      // and go back through the same cooldown-aware gate as everything else,
      // so a bad token can never turn into a refresh retry loop.
      if (creds.claudeAiOauth) creds.claudeAiOauth.expiresAt = Date.now() - 1;
      token = await getToken(creds, path);
      usage = await fetchUsage(token);
    } else throw e;
  }
  return snapFromUsage(usage);
}

// Claude Pro snapshot: prefer the optional long-lived setup token (zero calls
// to the refresh endpoint, ever); otherwise the normal sign-in with the
// scheduled refresh above. A rejected setup token falls back to the sign-in
// with a single warning instead of failing the stream.
async function fetchProSnapshot(proCreds) {
  const setupTok = await findSetupToken();
  if (setupTok) {
    try { return snapFromUsage(await fetchUsage(setupTok)); }
    catch (e) {
      if (e && e.code === 429) throw e;
      warnOnce("long-lived sharer token not accepted (" + ((e && e.message) || "error") + "); using the normal sign-in");
    }
  }
  if (!proCreds) throw new Error("No Claude Pro sign-in found");
  return fetchAnthropicSnapshot(proCreds.creds, proCreds.path);
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
    else if (e.retryMs && e.retryMs > 0) {
      // Honor the header, but never dip below the floor: this endpoint is
      // known to answer 429 with retry-after: 0, which would otherwise retry
      // instantly and re-trip the limit forever.
      s.nextAt = now + Math.min(600000, Math.max(MIN_429_BACKOFF_MS, e.retryMs + 3000 + Math.floor(Math.random() * 4000)));
    } else {
      s.backoff = Math.min(300000, Math.max(MIN_429_BACKOFF_MS, (s.backoff || PUSH_MS) * 2));
      s.nextAt = now + s.backoff;
    }
    warnOnce("busy [" + label + "] - next try " + fmtClock(s.nextAt) + "  (" + (e.message || "429") + ")");
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
  const proCreds = await findProCreds();
  const provider = await detectProvider();
  const streams = [];
  const notes = [];
  // A pause caused by an expired/rate-limited sign-in ends the moment a fresh
  // login lands on disk (the member re-logged-in, or a sibling refreshed) -
  // this local file check costs nothing and makes recovery instant, keeping
  // the "a re-login is picked up automatically" promise in the pause message.
  if (now < sources.pro.nextAt && sources.pro.resumeOnFreshCreds && proCreds) {
    const fo = proCreds.creds.claudeAiOauth;
    if (fo && fo.accessToken && typeof fo.expiresAt === "number" && now < fo.expiresAt - EXPIRY_BUFFER_MS) {
      sources.pro.nextAt = 0; sources.pro.resumeOnFreshCreds = false;
      console.log("  " + stamp() + "  found a fresh Claude sign-in on disk - resuming now");
    }
  }
  if (now >= sources.pro.nextAt) {
    try {
      const snap = await fetchProSnapshot(proCreds);
      streams.push({ source: "claude_pro", label: "Claude Pro", five_hour: snap.five_hour, seven_day: snap.seven_day, limits: snap.limits, provider: null });
      sources.pro.backoff = 0; sources.pro.streak = 0; sources.pro.nextAt = 0; sources.pro.resumeOnFreshCreds = false;
    } catch (e) { if (!pauseSource("pro", "Claude Pro", e)) notes.push("Claude Pro: " + ((e && e.message) || "error")); }
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
    console.log("  " + stamp() + "  [" + s.label + "] usage sent to dashboard  (5-hour: " + (f == null ? "-" : f + "%") + ")");
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

console.log("");
console.log("  ============================================");
console.log("   Claude Usage Sharer v" + SHARER_VERSION + " is running.");
console.log("   Your usage now shows on the class dashboard, live.");
console.log("   Keep this window open. Close it anytime to stop.");
console.log("  ============================================");
console.log("");
loop();
`;

export function buildMemberBridge(cfg: {
  ingestUrl: string;
  pullUrl: string;
  token: string;
}): string {
  return SOURCE.split("__INGEST_URL__")
    .join(cfg.ingestUrl)
    .split("__PULL_URL__")
    .join(cfg.pullUrl)
    .split("__BRIDGE_TOKEN__")
    .join(cfg.token);
}
