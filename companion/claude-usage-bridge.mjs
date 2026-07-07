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
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const MAX_BACKOFF_MS = 300_000; // cap 429 backoff at 5 min

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

async function resolveToken() {
  // 1) Explicit token wins (paste from `claude setup-token`).
  if (cfg.accessToken) return cfg.accessToken;

  // 2) Otherwise read the Claude Code subscription token from the creds file.
  let raw;
  try {
    raw = await readFile(cfg.credentialsPath, "utf8");
  } catch {
    throw new Error(
      `No CLAUDE_ACCESS_TOKEN set and could not read ${cfg.credentialsPath}. ` +
        `Run "claude setup-token" and put the result in CLAUDE_ACCESS_TOKEN.`,
    );
  }
  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error(
      "No claudeAiOauth.accessToken in the creds file (this Claude Code isn't logged into a Claude " +
        'subscription). Run "claude setup-token" and set CLAUDE_ACCESS_TOKEN instead.',
    );
  }
  return oauth.accessToken;
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
    throw Object.assign(new Error('Token expired — run any "claude" command to refresh it.'), { code: 401 });
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
  const token = await resolveToken();
  const usage = await fetchUsage(token);
  await push(usage);
  lastFetchAt = Date.now();
  backoff = 0;
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
      backoff = Math.min(MAX_BACKOFF_MS, (backoff || cfg.pushMs) * 2);
      console.warn(`${stamp()}  rate limited — backing off ${Math.round(backoff / 1000)}s`);
    } else {
      console.warn(`${stamp()}  ${e.message}`);
    }
  } finally {
    setTimeout(loop, backoff || cfg.commandMs);
  }
}

console.log("Claude Usage Bridge (push mode)");
console.log(`  → ingest:      ${cfg.ingestUrl}`);
console.log(`  token source: ${cfg.accessToken ? "CLAUDE_ACCESS_TOKEN (pasted)" : cfg.credentialsPath}`);
console.log(`  push every:   ${cfg.pushMs / 1000}s · pull-check ${cfg.commandMs / 1000}s · UA ${cfg.userAgent}`);
console.log(`  target user:  ${cfg.userId || "(pinned by server CLAUDE_BRIDGE_USER_ID)"}\n`);
loop();
