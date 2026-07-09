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
  // How often to fetch+push on the regular cadence. Default 60s (was 30s): the
  // unofficial /api/oauth/usage endpoint is aggressively rate-limited and 30s
  // pollers reliably trip a session-long 429 (anthropics/claude-code #31637).
  // Clamped ≥30s so an env override can't push us back into the danger zone.
  pushMs: Math.max(30_000, Number(process.env.POLL_MS) || 60_000),
  // +/- jitter on the cadence so multiple instances/members don't sync into a
  // lockstep burst on the shared usage endpoint.
  pushJitterMs: 8_000,
  // Never retry a 429 faster than this, even if the server sends retry-after: 0
  // (a documented footgun on this endpoint) — a "0" would spin us back in.
  min429BackoffMs: 60_000,
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
  // Optional: cc-switch's local SQLite DB, read-only, to detect which provider
  // (Claude official vs. a GLM/other gateway) is currently active — purely
  // informational, never affects which account /api/oauth/usage reports on.
  ccSwitchDbPath:
    process.env.CC_SWITCH_DB_PATH ?? join(homedir(), ".cc-switch", "cc-switch.db"),
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
  // Unique temp name per process+call: a SHARED temp path would let two
  // simultaneous writers truncate/rename over each other and corrupt the creds
  // file (bricking both → re-login). pid+random keeps each write isolated;
  // rename is atomic so readers always see a whole file, never a torn one.
  const tmp = `${cfg.credentialsPath}.${process.pid}.${Math.floor(Math.random() * 1e9)}.bridge.tmp`;
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
      const ra = resp.headers.get("retry-after");
      const reset = resp.headers.get("anthropic-ratelimit-unified-reset");
      throw Object.assign(
        new Error(
          `Token refresh rate limited (429) at ${url}${ra ? ` retry-after=${ra}s` : ""}${
            reset ? ` reset=${reset}` : ""
          }.`,
        ),
        { code: 429, source: "refresh", retryMs: retryMsFrom(ra, reset) },
      );
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

/**
 * Refresh de-duplication across restarts AND multiple processes sharing one
 * credentials file. The refresh endpoint ROTATES the refresh token on success,
 * so two refreshers at once invalidate each other and stampede into a 429 (the
 * thing that bricks the login). Before a network refresh we: (1) wait a short
 * random jitter so simultaneous starters desync; (2) re-read the file — if a
 * sibling already refreshed it (a newer, still-valid expiresAt than the token
 * we came in with), ADOPT that token and skip the network entirely; else
 * refresh using the newest refresh token on disk (never a stale rotated one).
 *
 * @param staleExp the expiresAt we decided to refresh against — adopt only a
 *   strictly-newer disk token, so we don't loop on our own just-written value.
 */
async function refreshOrAdoptFromDisk(creds, staleExp) {
  await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 800)));
  try {
    const fresh = JSON.parse(await readFile(cfg.credentialsPath, "utf8"));
    const fo = fresh.claudeAiOauth;
    if (
      fo?.accessToken &&
      typeof fo.expiresAt === "number" &&
      fo.expiresAt > staleExp &&
      Date.now() < fo.expiresAt - EXPIRY_BUFFER_MS
    ) {
      creds.claudeAiOauth = fo;
      console.log(`${stamp()}  adopted a fresher token from disk (another process refreshed it)`);
      return fo.accessToken;
    }
    if (fo?.refreshToken) creds.claudeAiOauth = fo; // refresh with newest on-disk token
  } catch {
    /* unreadable / torn write — fall through and refresh what we have */
  }
  return await refreshCredentials(creds);
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
      return await refreshOrAdoptFromDisk(creds, exp);
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
  if (resp.status === 429) {
    const ra = resp.headers.get("retry-after");
    const reset =
      resp.headers.get("anthropic-ratelimit-unified-reset") || resp.headers.get("x-ratelimit-reset");
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 160);
    } catch {
      /* body may be empty */
    }
    throw Object.assign(
      new Error(
        `Anthropic usage rate-limited (429)${ra ? ` retry-after=${ra}s` : ""}${
          reset ? ` reset=${reset}` : ""
        }${detail ? ` body=${detail}` : ""}`,
      ),
      { code: 429, source: "usage", retryMs: retryMsFrom(ra, reset) },
    );
  }
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

/**
 * Best-effort, read-only peek at cc-switch's local SQLite DB to see which
 * provider is currently selected for Claude Code (e.g. official Anthropic vs.
 * a GLM/other gateway routed through ANTHROPIC_BASE_URL). This is PURELY
 * informational for the dashboard badge — /api/oauth/usage always reports on
 * whatever Claude account is in ~/.claude/.credentials.json regardless of
 * which gateway cc-switch has routed coding traffic through, so a wrong or
 * missing read here never affects the usage numbers themselves.
 *
 * Every failure mode (cc-switch not installed, DB locked, schema changed,
 * node:sqlite unavailable on older Node) is swallowed and yields `null`.
 */
async function detectProvider() {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(cfg.ccSwitchDbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "select name, settings_config from providers where app_type = 'claude' and is_current = 1 limit 1",
        )
        .get();
      if (!row) return null;
      let env = {};
      try {
        env = JSON.parse(row.settings_config ?? "{}").env || {};
      } catch {
        // malformed settings_config — still report the provider name.
      }
      const baseUrl = env.ANTHROPIC_BASE_URL || null;
      const host = baseUrl ? safeHostname(baseUrl) : null;
      const official = !host || host === "anthropic.com" || host.endsWith(".anthropic.com");
      // GLM Coding Plan gateways (z.ai global, bigmodel.cn CN) expose the same
      // /api/monitor/usage/quota/limit endpoint.
      const isGlm = !!host && (host === "z.ai" || host.endsWith(".z.ai") || host.includes("bigmodel"));
      return {
        name: row.name ?? null,
        gateway_host: official ? null : host,
        official,
        source: official ? "anthropic" : isGlm ? "zai" : "other",
        // Local-only, NEVER pushed to the server (see safeProvider()).
        authToken: env.ANTHROPIC_AUTH_TOKEN || null,
        monitorUrl: host ? `https://${host}/api/monitor/usage/quota/limit` : null,
      };
    } finally {
      db.close();
    }
  } catch {
    return null; // cc-switch not present, wrong Node version, DB locked, etc.
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Public subset of a provider that's safe to send to the server (no token). */
function safeProvider(provider) {
  if (!provider) return null;
  return { name: provider.name, gateway_host: provider.gateway_host, official: provider.official };
}

/**
 * Fetch GLM Coding Plan usage from a z.ai/bigmodel gateway. Uses the provider's
 * own key (Authorization with NO "Bearer" prefix — that's what the endpoint
 * wants). Maps the token windows to our shape: unit=3/number=5 is the 5-hour
 * window, unit=6/number=1 is the weekly window. TIME_LIMIT rows (MCP tools) are
 * ignored. The key never leaves this machine — only the percentages are pushed.
 */
async function fetchGlmUsage(provider) {
  const r = await fetch(provider.monitorUrl, {
    method: "GET",
    headers: {
      Authorization: provider.authToken,
      "Accept-Language": "en-US,en",
      "Content-Type": "application/json",
    },
  });
  if (r.status === 401 || r.status === 403)
    throw new Error(`GLM provider rejected the key (${r.status}).`);
  if (r.status === 429) {
    const ra = r.headers.get("retry-after");
    throw Object.assign(
      new Error(`GLM provider rate limited (429)${ra ? ` retry-after=${ra}s` : ""}.`),
      { code: 429, source: "GLM", retryMs: retryMsFrom(ra, null) },
    );
  }
  if (!r.ok) throw new Error(`GLM usage endpoint returned ${r.status}.`);
  const j = await r.json();
  const rows = j?.data?.limits;
  const list = Array.isArray(rows) ? rows : [];
  let five = null;
  let week = null;
  for (const l of list) {
    if (l.type !== "TOKENS_LIMIT") continue; // skip TIME_LIMIT (MCP tools)
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
  const body = {
    ...(cfg.userId ? { user_id: cfg.userId } : {}),
    five_hour: snapshot.five_hour,
    seven_day: snapshot.seven_day,
    limits: snapshot.limits,
    provider: safeProvider(provider),
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
let rateLimitStreak = 0; // consecutive 429s — drives the "stop restarting" alarm
let pushJitter = 0; // re-rolled per push so cadence never lands on a fixed tick

/** Warn, but suppress consecutive duplicates so an outage doesn't spam the log. */
function warnOnce(msg) {
  if (msg === lastWarn) return;
  lastWarn = msg;
  console.warn(`${stamp()}  ${msg}`);
}

/**
 * Turn a 429's rate-limit headers into a wait in ms. `retry-after` is seconds;
 * the reset header is an absolute unix time (seconds). Honoring this is what
 * stops a burst of refreshes from hammering the endpoint (the thing that bricks
 * the login for hours). Returns 0 if neither header is usable.
 */
function retryMsFrom(retryAfter, reset) {
  if (retryAfter) {
    const s = parseInt(retryAfter, 10);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
  }
  if (reset) {
    const t = parseInt(reset, 10);
    if (Number.isFinite(t)) {
      const ms = t * 1000 - Date.now();
      if (ms > 0) return ms;
    }
  }
  return 0;
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

/** Does the local creds file have a usable Claude subscription token? */
async function hasClaudeSubscription() {
  if (cfg.accessToken) return true; // an explicit setup-token counts
  try {
    const creds = JSON.parse(await readFile(cfg.credentialsPath, "utf8"));
    const o = creds.claudeAiOauth;
    return !!(o && o.accessToken && o.refreshToken);
  } catch {
    return false;
  }
}

/** Fetch real Anthropic subscription usage and shape it like a GLM snapshot. */
async function fetchAnthropicSnapshot() {
  let token = await resolveToken();
  let usage;
  try {
    usage = await fetchUsage(token);
  } catch (e) {
    // Reactive refresh: token looked valid but was rejected → force a refresh once.
    if (e.code === 401 && !cfg.accessToken && Date.now() - lastRefreshAttemptAt >= REFRESH_MIN_INTERVAL_MS) {
      lastRefreshAttemptAt = Date.now();
      const creds = JSON.parse(await readFile(cfg.credentialsPath, "utf8"));
      const exp0 = typeof creds.claudeAiOauth?.expiresAt === "number" ? creds.claudeAiOauth.expiresAt : 0;
      token = await refreshOrAdoptFromDisk(creds, exp0);
      usage = await fetchUsage(token);
    } else {
      throw e;
    }
  }
  return {
    five_hour: pickWindow(usage.five_hour),
    seven_day: pickWindow(usage.seven_day),
    limits: normalizeLimits(usage),
  };
}

/**
 * Provider-aware fetch. If cc-switch is routed to a GLM gateway AND there's no
 * Claude subscription token to read, report the GLM plan's usage (its own key,
 * its own quota endpoint). Otherwise report the Claude subscription usage as
 * before. This keeps the rings meaningful across a cc-switch/account switch
 * instead of erroring out when the subscription login is gone.
 */
async function fetchAndPush(reason) {
  const provider = await detectProvider();
  const subscribed = await hasClaudeSubscription();

  let snapshot;
  let sourceLabel;
  if (provider && provider.source === "zai" && provider.authToken && !subscribed) {
    // GLM-routed and no Claude subscription token available → GLM usage.
    snapshot = await fetchGlmUsage(provider);
    sourceLabel = "GLM";
  } else {
    // Claude subscription (default, or GLM-routed but still logged into Claude).
    snapshot = await fetchAnthropicSnapshot();
    sourceLabel = "Claude";
  }

  await push(snapshot, provider);
  lastFetchAt = Date.now();
  backoff = 0;
  rateLimitStreak = 0; // a good push clears the 429 streak → alarm re-arms fresh
  lastWarn = "";
  const f = snapshot.five_hour?.utilization;
  const s = snapshot.seven_day?.utilization;
  const via = provider ? `  via ${provider.name}${provider.official ? "" : ` (${provider.gateway_host})`}` : "";
  console.log(
    `${stamp()}  [${sourceLabel}] 5h=${f ?? "—"}%  7d=${s ?? "—"}%  → pushed${reason ? ` (${reason})` : ""}${via}`,
  );
}

async function loop() {
  try {
    const pullTs = await checkPullRequest();
    const pullRequested = pullTs > lastPullSeen;
    if (pullRequested) lastPullSeen = pullTs;

    const sinceFetch = Date.now() - lastFetchAt;
    // Steady-state jitter: a scheduled push waits pushMs + a small random slice
    // so multiple instances/members don't line up on the shared usage endpoint.
    // A user-initiated pull bypasses it (still bounded by minFetchGapMs).
    const due = sinceFetch >= cfg.pushMs + pushJitter;
    const gapOk = sinceFetch >= cfg.minFetchGapMs;

    if ((pullRequested || due) && gapOk) {
      await fetchAndPush(pullRequested ? "pull" : "");
      pushJitter = Math.floor(Math.random() * cfg.pushJitterMs);
    }
  } catch (e) {
    if (e.code === 429) {
      rateLimitStreak++;
      // Prefer the server's own retry window (retry-after / reset header) over a
      // blind doubling ladder: waiting exactly as long as the server asked (plus
      // a small cushion) means the NEXT attempt succeeds instead of re-tripping
      // the 429 and dragging the lockout out for hours. Fall back to the ladder
      // only when no header was sent.
      if (e.retryMs && e.retryMs > 0) {
        // Honor the header, but never below the floor: this endpoint is known to
        // return 429 with retry-after: 0, which would retry instantly and re-trip.
        backoff = Math.min(MAX_BACKOFF_MS, Math.max(cfg.min429BackoffMs, e.retryMs + 3000 + Math.floor(Math.random() * 4000)));
      } else {
        backoff = Math.min(MAX_BACKOFF_MS, Math.max(cfg.min429BackoffMs, (backoff || cfg.pushMs) * 2));
      }
      // Name the throttled endpoint (refresh / usage / GLM) + its detail so the
      // log pinpoints WHAT is rate-limiting instead of an opaque "rate limited".
      warnOnce(
        `rate limited [${e.source || "?"}] — backing off ${Math.round(backoff / 1000)}s  (${e.message || "429"})`,
      );
      // After a few 429s in a row, shout the human fix: DON'T restart. Restarting
      // resets the timer and fires another immediate request, which is exactly
      // what keeps the endpoint locked (and can let the token expire → needs a
      // fresh login). Reprinted every 3rd hit so it can't scroll away unseen.
      if (rateLimitStreak === 3 || (rateLimitStreak > 3 && rateLimitStreak % 3 === 0)) {
        console.warn(
          `\n  ⚠  Rate-limited ${rateLimitStreak}× in a row on [${e.source || "?"}].\n` +
            `     DO NOT close/restart this window — that makes it worse and can\n` +
            `     lock your sign-in until it expires. Just LEAVE IT OPEN; it waits\n` +
            `     out the server's cooldown and recovers on its own.\n`,
        );
      }
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
