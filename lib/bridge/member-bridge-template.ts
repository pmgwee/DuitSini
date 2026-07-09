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
 * Whichever sources exist are fetched each cycle and pushed together in one
 * call. A source that fails is skipped (warned), not fatal.
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
import { join } from "node:path";

const INGEST_URL = "__INGEST_URL__";
const PULL_URL = "__PULL_URL__";
const BRIDGE_TOKEN = "__BRIDGE_TOKEN__";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_ENDPOINTS = ["https://platform.claude.com/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"];
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CC_SWITCH_DB = join(homedir(), ".cc-switch", "cc-switch.db");
const UA = "claude-code/2.1.0";
// PUSH_MS is 60s (was 30s): the unofficial /api/oauth/usage endpoint is
// aggressively rate-limited and third-party pollers at 30s reliably trip a
// session-long 429 (anthropics/claude-code issues #31637/#30930/#31021). 60s
// keeps us comfortably under that trigger while the dashboard still feels live.
// PUSH_JITTER_MS spreads the fixed cadence by +/- a few seconds so multiple
// instances (or several members) don't line up and hit the endpoint in lockstep.
// MIN_429_BACKOFF_MS is a floor: some 429s come back with retry-after: 0 (a
// documented footgun on this endpoint) - never retry faster than this, or a
// "0" would spin us straight back into the limit.
const PUSH_MS = 60000, PUSH_JITTER_MS = 8000, COMMAND_MS = 4000, MIN_GAP_MS = 9000, EXPIRY_BUFFER_MS = 300000, REFRESH_MIN_MS = 45000, MIN_429_BACKOFF_MS = 60000;

let lastFetchAt = 0, lastPullSeen = 0, lastRefreshAt = 0, lastWarn = "", backoff = 0, rateLimitStreak = 0, pushJitter = 0;
const stamp = () => new Date().toLocaleTimeString();
function warnOnce(m) { if (m === lastWarn) return; lastWarn = m; console.warn("  " + stamp() + "  " + m); }

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
// token. Returns { path, creds } or null.
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
    if (!resp.ok) { throw new Error("Could not refresh your sign-in (" + resp.status + ")."); }
    const j = await resp.json();
    if (!j.access_token) throw new Error("Refresh returned no token.");
    creds.claudeAiOauth.accessToken = j.access_token;
    if (j.refresh_token) creds.claudeAiOauth.refreshToken = j.refresh_token;
    creds.claudeAiOauth.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    await writeCreds(path, creds);
    console.log("  " + stamp() + "  refreshed your Claude sign-in");
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

async function getToken(creds, path) {
  const o = creds.claudeAiOauth;
  if (!o || !o.accessToken || !o.refreshToken) throw new Error("Please sign in to Claude Code with your Claude Pro/Max account first.");
  const now = Date.now(), exp = typeof o.expiresAt === "number" ? o.expiresAt : 0;
  if (now < exp - EXPIRY_BUFFER_MS) return o.accessToken;
  if (now - lastRefreshAt >= REFRESH_MIN_MS) {
    lastRefreshAt = now;
    try { return await refreshOrAdoptFromDisk(creds, path, exp); }
    catch (e) { if (now < exp) { warnOnce("couldn't refresh yet (" + e.message + "); using current sign-in"); return o.accessToken; } throw e; }
  }
  if (now < exp) return o.accessToken;
  throw new Error("Your Claude sign-in expired; will retry shortly.");
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

async function fetchAnthropicSnapshot(creds, path) {
  let token = await getToken(creds, path), usage;
  try { usage = await fetchUsage(token); }
  catch (e) { if (e.code === 401 && Date.now() - lastRefreshAt >= REFRESH_MIN_MS) { lastRefreshAt = Date.now(); const exp0 = (creds.claudeAiOauth && creds.claudeAiOauth.expiresAt) || 0; token = await refreshOrAdoptFromDisk(creds, path, exp0); usage = await fetchUsage(token); } else throw e; }
  return { five_hour: pickWindow(usage.five_hour), seven_day: pickWindow(usage.seven_day), limits: normLimits(usage) };
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

async function fetchAndPush(reason) {
  const proCreds = await findProCreds();
  const provider = await detectProvider();
  const streams = [];
  const notes = [];
  if (proCreds) {
    try {
      const snap = await fetchAnthropicSnapshot(proCreds.creds, proCreds.path);
      streams.push({ source: "claude_pro", label: "Claude Pro", five_hour: snap.five_hour, seven_day: snap.seven_day, limits: snap.limits, provider: null });
    } catch (e) { if (e.code === 429) { e.source = "Claude Pro"; throw e; } notes.push("Claude Pro: " + e.message); }
  } else {
    notes.push("No Claude Pro sign-in found");
  }
  if (provider && provider.source === "zai" && provider.authToken) {
    try {
      const snap = await fetchGlmUsage(provider);
      streams.push({ source: "glm", label: "GLM Coding", five_hour: snap.five_hour, seven_day: snap.seven_day, limits: snap.limits, provider: safeProvider(provider) });
    } catch (e) { if (e.code === 429) { e.source = "GLM"; throw e; } notes.push("GLM: " + e.message); }
  }
  if (streams.length === 0) throw new Error("No usage sent. " + notes.join(" / "));
  await pushStreams(streams);
  lastFetchAt = Date.now(); lastWarn = ""; rateLimitStreak = 0;
  for (const s of streams) {
    const f = s.five_hour && s.five_hour.utilization;
    console.log("  " + stamp() + "  [" + s.label + "] usage sent to dashboard  (5-hour: " + (f == null ? "-" : f + "%") + ")");
  }
  if (reason) console.log("  " + stamp() + "  [" + reason + "]");
}

async function loop() {
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
    if (e && e.code === 429) {
      rateLimitStreak++;
      // Prefer the server's own retry window (retry-after / reset header) - THIS
      // is the fix for the endpoint bricking itself: instead of guessing with a
      // doubling ladder that keeps poking before the limit clears, we wait
      // exactly as long as the server asked (plus a few seconds of cushion), so
      // the very next attempt succeeds instead of re-tripping the 429. If no
      // header was sent, fall back to the exponential ladder as before.
      if (e.retryMs && e.retryMs > 0) {
        // Honor the header, but never dip below the floor: this endpoint is
        // known to answer 429 with retry-after: 0, which would otherwise retry
        // instantly and re-trip the limit forever.
        backoff = Math.min(600000, Math.max(MIN_429_BACKOFF_MS, e.retryMs + 3000 + Math.floor(Math.random() * 4000)));
      } else {
        backoff = Math.min(300000, Math.max(MIN_429_BACKOFF_MS, (backoff || PUSH_MS) * 2));
      }
      // Name the throttled source + its detail so the log says WHICH endpoint is
      // rate-limiting (Claude Pro token-refresh vs. usage vs. GLM) and why,
      // instead of an opaque "busy".
      warnOnce("busy [" + (e.source || "?") + "] - waiting " + Math.round(backoff / 1000) + "s  (" + (e.message || "429") + ")");
      // After a few 429s in a row, shout the human fix: DON'T restart. Restarting
      // resets the timer and fires another immediate request, which is what keeps
      // the sign-in locked (and can let it expire -> needs a fresh login).
      // Reprinted every 3rd hit so it cannot scroll away unseen.
      if (rateLimitStreak === 3 || (rateLimitStreak > 3 && rateLimitStreak % 3 === 0)) {
        console.warn("");
        console.warn("  !!  Rate-limited " + rateLimitStreak + " times in a row on [" + (e.source || "?") + "].");
        console.warn("      DO NOT close or restart this window - that makes it worse and can");
        console.warn("      lock your sign-in until it expires. Just LEAVE IT OPEN; it waits out");
        console.warn("      the cooldown and recovers on its own.");
        console.warn("");
      }
    } else {
      // Network/server error (typical after sleep/wake or a transient blip).
      // Retry SOON rather than climbing the 429 ladder - we can't be "busy" if
      // we never reached the server. Capped short so the bridge recovers within
      // seconds once the connection is back, instead of sitting dormant for
      // minutes (which is what made restarts feel necessary).
      backoff = 15000;
      warnOnce((e && e.message) || "fetch failed");
    }
  } finally { setTimeout(loop, backoff || COMMAND_MS); }
}

console.log("");
console.log("  ============================================");
console.log("   Claude Usage Sharer is running.");
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
