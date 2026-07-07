/**
 * Builds the personalized `claude-usage-sharer.mjs` a group member downloads.
 * The script is self-contained (Node 20+ only), reads the member's own Claude
 * Code token from ~/.claude/.credentials.json, self-refreshes it, and pushes
 * usage % to the app authenticated by their per-user bridge token.
 *
 * IMPORTANT: the SOURCE below must contain NO backticks, no ${...}, and no
 * backslashes, so it embeds safely inside this template literal. Config is
 * injected via the __PLACEHOLDER__ tokens.
 */

const SOURCE = `#!/usr/bin/env node
/*
 * Claude Usage Sharer (personal, for the class dashboard).
 * Reads YOUR Claude Code usage from THIS computer and sends only the
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
const CREDS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
const CC_SWITCH_DB = join(homedir(), ".cc-switch", "cc-switch.db");
const UA = "claude-code/2.1.0";
const PUSH_MS = 30000, COMMAND_MS = 4000, MIN_GAP_MS = 9000, EXPIRY_BUFFER_MS = 300000, REFRESH_MIN_MS = 45000;

let lastFetchAt = 0, lastPullSeen = 0, lastRefreshAt = 0, lastWarn = "", backoff = 0;
const stamp = () => new Date().toLocaleTimeString();
function warnOnce(m) { if (m === lastWarn) return; lastWarn = m; console.warn("  " + stamp() + "  " + m); }

async function writeCreds(creds) {
  const tmp = CREDS + ".sharer.tmp";
  await writeFile(tmp, JSON.stringify(creds, null, 2), "utf8");
  await rename(tmp, CREDS);
}

async function refresh(creds) {
  const rt = creds.claudeAiOauth && creds.claudeAiOauth.refreshToken;
  if (!rt) throw new Error("Please open Claude Code and sign in first.");
  let lastErr;
  for (const url of TOKEN_ENDPOINTS) {
    let resp;
    try { resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify({ grant_type: "refresh_token", refresh_token: rt, client_id: OAUTH_CLIENT_ID }) }); }
    catch (e) { lastErr = e; continue; }
    if (resp.status === 404) { lastErr = new Error("token endpoint 404"); continue; }
    if (resp.status === 429) { throw Object.assign(new Error("Anthropic busy; will retry."), { code: 429 }); }
    if (!resp.ok) { throw new Error("Could not refresh your sign-in (" + resp.status + ")."); }
    const j = await resp.json();
    if (!j.access_token) throw new Error("Refresh returned no token.");
    creds.claudeAiOauth.accessToken = j.access_token;
    if (j.refresh_token) creds.claudeAiOauth.refreshToken = j.refresh_token;
    creds.claudeAiOauth.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
    await writeCreds(creds);
    console.log("  " + stamp() + "  refreshed your Claude sign-in");
    return creds.claudeAiOauth.accessToken;
  }
  throw lastErr || new Error("Refresh failed.");
}

async function getToken() {
  let creds;
  try { creds = JSON.parse(await readFile(CREDS, "utf8")); }
  catch { throw new Error("Could not find your Claude Code sign-in. Open Claude Code, sign in, then run this again."); }
  const o = creds.claudeAiOauth;
  if (!o || !o.accessToken || !o.refreshToken) throw new Error("Please sign in to Claude Code with your Claude account first.");
  const now = Date.now(), exp = typeof o.expiresAt === "number" ? o.expiresAt : 0;
  if (now < exp - EXPIRY_BUFFER_MS) return o.accessToken;
  if (now - lastRefreshAt >= REFRESH_MIN_MS) {
    lastRefreshAt = now;
    try { return await refresh(creds); }
    catch (e) { if (now < exp) { warnOnce("couldn't refresh yet (" + e.message + "); using current sign-in"); return o.accessToken; } throw e; }
  }
  if (now < exp) return o.accessToken;
  throw new Error("Your Claude sign-in expired; will retry shortly.");
}

async function fetchUsage(token) {
  const r = await fetch(USAGE_ENDPOINT, { headers: { Authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": UA, "Content-Type": "application/json" } });
  if (r.status === 401) throw Object.assign(new Error("Sign-in rejected; will refresh."), { code: 401 });
  if (r.status === 429) throw Object.assign(new Error("Anthropic busy; will retry."), { code: 429 });
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

// Does the local creds file hold a usable Claude subscription login?
async function hasSubscription() {
  try { const creds = JSON.parse(await readFile(CREDS, "utf8")); const o = creds.claudeAiOauth; return !!(o && o.accessToken && o.refreshToken); }
  catch { return false; }
}

// Fetch GLM Coding Plan usage from a z.ai/bigmodel gateway using the provider's
// own key (Authorization with NO Bearer prefix). unit=3/number=5 is the 5-hour
// window; unit=6/number=1 is the weekly window. TIME_LIMIT rows (MCP tools) are
// skipped. The key stays on this machine - only the percentages are sent.
async function fetchGlmUsage(provider) {
  const r = await fetch(provider.monitorUrl, { headers: { Authorization: provider.authToken, "Accept-Language": "en-US,en", "Content-Type": "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("Your GLM plan key was rejected (" + r.status + ").");
  if (r.status === 429) throw Object.assign(new Error("GLM provider busy; will retry."), { code: 429 });
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

async function push(snapshot, provider) {
  const body = { five_hour: snapshot.five_hour, seven_day: snapshot.seven_day, limits: snapshot.limits, provider: safeProvider(provider) };
  const r = await fetch(INGEST_URL, { method: "POST", headers: { Authorization: "Bearer " + BRIDGE_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text().catch(function () { return ""; }); throw new Error("Sending to dashboard failed (" + r.status + ")" + (t ? ": " + t.slice(0, 120) : "")); }
}

async function checkPull() {
  try { const r = await fetch(PULL_URL, { headers: { Authorization: "Bearer " + BRIDGE_TOKEN } }); if (!r.ok) return 0; const j = await r.json(); return j.pull_requested_at ? Date.parse(j.pull_requested_at) : 0; }
  catch { return 0; }
}

async function fetchAnthropicSnapshot() {
  let token = await getToken(), usage;
  try { usage = await fetchUsage(token); }
  catch (e) { if (e.code === 401 && Date.now() - lastRefreshAt >= REFRESH_MIN_MS) { lastRefreshAt = Date.now(); const creds = JSON.parse(await readFile(CREDS, "utf8")); token = await refresh(creds); usage = await fetchUsage(token); } else throw e; }
  return { five_hour: pickWindow(usage.five_hour), seven_day: pickWindow(usage.seven_day), limits: normLimits(usage) };
}

async function fetchAndPush(reason) {
  const provider = await detectProvider();
  const subscribed = await hasSubscription();
  let snapshot, label;
  if (provider && provider.source === "zai" && provider.authToken && !subscribed) {
    snapshot = await fetchGlmUsage(provider); label = "GLM";
  } else {
    snapshot = await fetchAnthropicSnapshot(); label = "Claude";
  }
  await push(snapshot, provider);
  lastFetchAt = Date.now(); lastWarn = "";
  const f = snapshot.five_hour && snapshot.five_hour.utilization;
  const via = provider ? "  via " + provider.name + (provider.official ? "" : " (" + provider.gateway_host + ")") : "";
  console.log("  " + stamp() + "  [" + label + "] usage sent to dashboard  (5-hour: " + (f == null ? "-" : f + "%") + ")" + (reason ? "  [" + reason + "]" : "") + via);
}

async function loop() {
  try {
    const pullTs = await checkPull();
    const pull = pullTs > lastPullSeen; if (pull) lastPullSeen = pullTs;
    const since = Date.now() - lastFetchAt;
    if ((pull || since >= PUSH_MS) && since >= MIN_GAP_MS) { await fetchAndPush(pull ? "refresh requested" : ""); backoff = 0; }
  } catch (e) {
    if (e.code === 429) { backoff = Math.min(300000, Math.max(45000, (backoff || PUSH_MS) * 2)); warnOnce("busy - waiting " + Math.round(backoff / 1000) + "s"); }
    else warnOnce(e.message);
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
