#!/usr/bin/env node
/**
 * Claude Usage Bridge — a LOCAL companion (NOT deployed to Vercel).
 *
 * Reads your Claude Code OAuth token from the local credentials file, fetches
 * your real 5-hour / 7-day plan usage from Anthropic's (unofficial)
 * `GET /api/oauth/usage` endpoint, and PUSHES it to your Subscription Agent
 * site's ingest route. The site then shows the live % on the dashboard — on any
 * device, including the deployed HTTPS site (a browser there cannot reliably
 * reach http://localhost, so we push instead of being polled).
 *
 * Personal use only. The token never leaves this machine — only the computed
 * utilization %/reset times are sent. It impersonates the Claude Code harness
 * via the User-Agent header (required to avoid 429s) and may break if Anthropic
 * changes the endpoint. See README.md.
 *
 * Run:  node --env-file=.env claude-usage-bridge.mjs
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const MAX_BACKOFF_MS = 300_000; // cap 429 backoff at 5 min

// OAuth token refresh — lets the bridge survive sleep/wake and run indefinitely
// without Claude Code running to keep the token fresh. Anthropic moved the
// endpoint to platform.claude.com; console.anthropic.com is a fallback.
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_ENDPOINTS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // refresh this long before expiry
const REFRESH_MIN_INTERVAL_MS = 45_000; // throttle attempts (endpoint is rate-limited)

const cfg = {
  ingestUrl: process.env.INGEST_URL, // e.g. https://your-app.vercel.app/api/claude-usage/ingest
  secret: process.env.BRIDGE_SECRET, // must equal CLAUDE_BRIDGE_SECRET on the server
  userId: process.env.CLAUDE_USER_ID ?? "", // optional if server sets CLAUDE_BRIDGE_USER_ID
  // How often to fetch+push on the regular cadence. Clamped ≥15s to respect
  // Anthropic's per-token rate limit (backs off further on 429).
  pushMs: Math.max(15_000, Number(process.env.POLL_MS) || 30_000),
  // How often to check the cheap "pull requested?" signal (no Anthropic call),
  // so the site's "Pull latest" button feels near-instant.
  commandMs: Math.max(2_000, Number(process.env.COMMAND_MS) || 4_000),
  // Never hit Anthropic more often than this, even on rapid pull requests.
  minFetchGapMs: 9_000,
  userAgent: `claude-code/${process.env.CC_VERSION ?? "2.1.0"}`,
  // A subscription OAuth token pasted directly (from `claude setup-token`).
  // Takes priority over the credentials file — use this when Claude Code isn't
  // logged into your Claude subscription (e.g. it's routed to another gateway).
  accessToken: process.env.CLAUDE_ACCESS_TOKEN ?? "",
  credentialsPath:
    process.env.CLAUDE_CREDENTIALS_PATH ??
    join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json"),
};

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}
if (!cfg.ingestUrl) die("INGEST_URL is required (see README.md / .env.example).");
if (!cfg.secret) die("BRIDGE_SECRET is required (must match the server's CLAUDE_BRIDGE_SECRET).");

// The pull-signal endpoint sits next to the ingest endpoint.
cfg.pullUrl = cfg.ingestUrl.replace(/\/ingest\/?$/, "/pull");

let lastRefreshAttemptAt = 0;

/** Atomically write the credentials file (temp + rename) to avoid corruption. */
async function writeCredentialsAtomic(creds) {
  const tmp = `${cfg.credentialsPath}.bridge.tmp`;
  await writeFile(tmp, JSON.stringify(creds, null, 2), "utf8");
  await rename(tmp, cfg.credentialsPath);
}

/**
 * Exchange the refresh token for a fresh access token (rotating the refresh
 * token too) and persist both back to the credentials file — exactly what
 * Claude Code does. Other fields (mcpOAuth, scopes, …) are preserved.
 */
async function refreshCredentials(creds) {
  const refreshToken = creds.claudeAiOauth?.refreshToken;
  if (!refreshToken) throw new Error("No refreshToken available to refresh with.");
  let lastErr;
  for (const url of TOKEN_ENDPOINTS) {
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": cfg.userAgent },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
    } catch (e) {
      lastErr = e; // network error — try the next endpoint
      continue;
    }
    if (resp.status === 404) {
      lastErr = new Error(`${url} → 404`); // wrong host — try the fallback
      continue;
    }
    if (resp.status === 429) {
      throw Object.assign(new Error("Token refresh rate limited (429)."), { code: 429 });
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Token refresh ${resp.status}${body ? `: ${body.slice(0, 140)}` : ""}`);
    }
    const j = await resp.json();
    if (!j.access_token) throw new Error("Token refresh response had no access_token.");
    creds.claudeAiOauth.accessToken = j.access_token;
    if (j.refresh_token) creds.claudeAiOauth.refreshToken = j.refresh_token;
    creds.claudeAiOauth.expiresAt = Date.now() + (j.expires_in ?? 3600) * 1000;
    await writeCredentialsAtomic(creds);
    console.log(`${stamp()}  token refreshed (valid ~${Math.round((j.expires_in ?? 3600) / 60)}m)`);
    return creds.claudeAiOauth.accessToken;
  }
  throw lastErr ?? new Error("Token refresh failed on all endpoints.");
}

async function resolveToken() {
  // 1) Explicit static token wins (paste from `claude setup-token`) — no refresh.
  if (cfg.accessToken) return cfg.accessToken;

  // 2) Read the Claude Code subscription token from the creds file.
  let creds;
  try {
    creds = JSON.parse(await readFile(cfg.credentialsPath, "utf8"));
  } catch {
    throw new Error(
      `No CLAUDE_ACCESS_TOKEN set and could not read ${cfg.credentialsPath}. ` +
        `Run "claude setup-token" and put the result in CLAUDE_ACCESS_TOKEN.`,
    );
  }
  const o = creds.claudeAiOauth;
  if (!o?.accessToken || !o?.refreshToken) {
    throw new Error(
      "No claudeAiOauth tokens in the creds file (this Claude Code isn't logged into a Claude " +
        'subscription). Run "claude setup-token" and set CLAUDE_ACCESS_TOKEN instead.',
    );
  }

  const now = Date.now();
  const exp = typeof o.expiresAt === "number" ? o.expiresAt : 0;
  if (now < exp - EXPIRY_BUFFER_MS) return o.accessToken; // comfortably valid

  // Near expiry or expired → refresh, throttled (the endpoint is rate-limited).
  if (now - lastRefreshAttemptAt >= REFRESH_MIN_INTERVAL_MS) {
    lastRefreshAttemptAt = now;
    try {
      return await refreshCredentials(creds);
    } catch (e) {
      // Still within the pre-expiry buffer → keep using the valid token, retry later.
      if (now < exp) {
        console.warn(`${stamp()}  refresh failed (${e.message}); using current token for now`);
        return o.accessToken;
      }
      throw e;
    }
  }
  if (now < exp) return o.accessToken; // valid within buffer, refresh cooling down
  throw new Error("Access token expired; refresh cooling down, will retry shortly.");
}

async function fetchUsage(token) {
  const resp = await fetch(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      // Required: requests without a claude-code User-Agent hit an aggressively
      // rate-limited bucket (persistent 429).
      "User-Agent": cfg.userAgent,
      "Content-Type": "application/json",
    },
  });
  if (resp.status === 401)
    throw Object.assign(new Error("Access token rejected (401) — will refresh."), { code: 401 });
  if (resp.status === 429) throw Object.assign(new Error("Rate limited by Anthropic."), { code: 429 });
  if (!resp.ok) throw new Error(`Usage endpoint returned ${resp.status}.`);
  return resp.json();
}

/** Map a raw window to our shape; tolerate missing fields (five_hour can be absent). */
function pickWindow(w) {
  if (!w || typeof w.utilization !== "number") return null;
  return { utilization: w.utilization, resets_at: w.resets_at ?? null };
}

/**
 * Normalize the endpoint's `limits` array into the shape the widget renders:
 * a session window + one bar per weekly limit ("All models", "Fable", …).
 * Any scoped model appears automatically — no code change per model.
 */
function normalizeLimits(usage) {
  if (!Array.isArray(usage.limits)) return null;
  return usage.limits.map((l) => {
    let key, label;
    if (l.kind === "session") {
      key = "session";
      label = "Current session";
    } else if (l.kind === "weekly_all") {
      key = "weekly_all";
      label = "All models";
    } else if (l.kind === "weekly_scoped") {
      const model = l.scope?.model?.display_name || "Scoped";
      key = `weekly:${model}`;
      label = model;
    } else {
      key = l.kind || "unknown";
      label = l.kind || "Unknown";
    }
    return {
      key,
      label,
      group: l.group === "session" ? "session" : "weekly",
      percent: typeof l.percent === "number" ? l.percent : null,
      resets_at: l.resets_at ?? null,
      severity: l.severity ?? null,
    };
  });
}

async function push(usage) {
  const body = {
    ...(cfg.userId ? { user_id: cfg.userId } : {}),
    five_hour: pickWindow(usage.five_hour),
    seven_day: pickWindow(usage.seven_day),
    limits: normalizeLimits(usage),
  };
  const resp = await fetch(cfg.ingestUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Ingest returned ${resp.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
  }
}

const stamp = () => new Date().toLocaleTimeString();
let backoff = 0;
let lastFetchAt = 0;
let lastPullSeen = 0;
let lastWarn = "";

/** Warn, but suppress consecutive duplicates so an outage doesn't spam the log. */
function warnOnce(msg) {
  if (msg === lastWarn) return;
  lastWarn = msg;
  console.warn(`${stamp()}  ${msg}`);
}

/** Cheap check (no Anthropic call): has the site requested a fresh pull? */
async function checkPullRequest() {
  try {
    const url = cfg.userId
      ? `${cfg.pullUrl}?user_id=${encodeURIComponent(cfg.userId)}`
      : cfg.pullUrl;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${cfg.secret}` } });
    if (!r.ok) return 0;
    const j = await r.json();
    return j.pull_requested_at ? Date.parse(j.pull_requested_at) : 0;
  } catch {
    return 0;
  }
}

async function fetchAndPush(reason) {
  let token = await resolveToken();
  let usage;
  try {
    usage = await fetchUsage(token);
  } catch (e) {
    // Reactive refresh: token looked valid but was rejected → force a refresh once.
    if (e.code === 401 && !cfg.accessToken && Date.now() - lastRefreshAttemptAt >= REFRESH_MIN_INTERVAL_MS) {
      lastRefreshAttemptAt = Date.now();
      const creds = JSON.parse(await readFile(cfg.credentialsPath, "utf8"));
      token = await refreshCredentials(creds);
      usage = await fetchUsage(token);
    } else {
      throw e;
    }
  }
  await push(usage);
  lastFetchAt = Date.now();
  backoff = 0;
  lastWarn = "";
  const f = usage.five_hour?.utilization;
  const s = usage.seven_day?.utilization;
  const scoped = Array.isArray(usage.limits)
    ? usage.limits.filter((l) => l.kind === "weekly_scoped").length
    : 0;
  console.log(
    `${stamp()}  5h=${f ?? "—"}%  7d=${s ?? "—"}%${scoped ? `  +${scoped} scoped` : ""}  → pushed${reason ? ` (${reason})` : ""}`,
  );
}

async function loop() {
  try {
    const pullTs = await checkPullRequest();
    const pullRequested = pullTs > lastPullSeen;
    if (pullRequested) lastPullSeen = pullTs;

    const sinceFetch = Date.now() - lastFetchAt;
    const due = sinceFetch >= cfg.pushMs;
    const gapOk = sinceFetch >= cfg.minFetchGapMs;

    if ((pullRequested || due) && gapOk) {
      await fetchAndPush(pullRequested ? "pull" : "");
    }
  } catch (e) {
    if (e.code === 429) {
      backoff = Math.min(MAX_BACKOFF_MS, Math.max(45_000, (backoff || cfg.pushMs) * 2));
      warnOnce(`rate limited — backing off ${Math.round(backoff / 1000)}s`);
    } else {
      warnOnce(e.message);
    }
  } finally {
    setTimeout(loop, backoff || cfg.commandMs);
  }
}

console.log("Claude Usage Bridge (push mode)");
console.log(`  → ingest:      ${cfg.ingestUrl}`);
console.log(
  `  token source: ${cfg.accessToken ? "CLAUDE_ACCESS_TOKEN (static)" : `${cfg.credentialsPath} (auto-refreshing)`}`,
);
console.log(`  push every:   ${cfg.pushMs / 1000}s · pull-check ${cfg.commandMs / 1000}s · UA ${cfg.userAgent}`);
console.log(`  target user:  ${cfg.userId || "(pinned by server CLAUDE_BRIDGE_USER_ID)"}\n`);
loop();
