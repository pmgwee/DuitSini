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

async function push(u) {
  const body = { five_hour: pickWindow(u.five_hour), seven_day: pickWindow(u.seven_day), limits: normLimits(u) };
  const r = await fetch(INGEST_URL, { method: "POST", headers: { Authorization: "Bearer " + BRIDGE_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text().catch(function () { return ""; }); throw new Error("Sending to dashboard failed (" + r.status + ")" + (t ? ": " + t.slice(0, 120) : "")); }
}

async function checkPull() {
  try { const r = await fetch(PULL_URL, { headers: { Authorization: "Bearer " + BRIDGE_TOKEN } }); if (!r.ok) return 0; const j = await r.json(); return j.pull_requested_at ? Date.parse(j.pull_requested_at) : 0; }
  catch { return 0; }
}

async function fetchAndPush(reason) {
  let token = await getToken(), usage;
  try { usage = await fetchUsage(token); }
  catch (e) { if (e.code === 401 && Date.now() - lastRefreshAt >= REFRESH_MIN_MS) { lastRefreshAt = Date.now(); const creds = JSON.parse(await readFile(CREDS, "utf8")); token = await refresh(creds); usage = await fetchUsage(token); } else throw e; }
  await push(usage);
  lastFetchAt = Date.now(); lastWarn = "";
  const f = usage.five_hour && usage.five_hour.utilization;
  console.log("  " + stamp() + "  usage sent to dashboard  (5-hour: " + (f == null ? "-" : f + "%") + ")" + (reason ? "  [" + reason + "]" : ""));
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
