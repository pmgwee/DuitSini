#!/usr/bin/env node
/**
 * Claude Usage Bridge — a LOCAL companion service (NOT deployed to Vercel).
 *
 * Reads the Claude Code OAuth token from the local credentials file and proxies
 * Anthropic's (unofficial) `GET /api/oauth/usage` endpoint, which returns the
 * real 5-hour and 7-day plan-usage windows (the same data behind Claude Code's
 * `/usage` and the claude.ai usage screen).
 *
 * Why a local process? The OAuth token lives on the user's machine only
 * (Windows: %USERPROFILE%\.claude\.credentials.json, macOS keychain,
 * Linux ~/.claude/.credentials.json), so a deployed app can't read it.
 *
 * Personal use only. Binds to 127.0.0.1. Run with: `node claude-usage-bridge.mjs`
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.PORT ?? 4785);
const HOST = "127.0.0.1";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 240_000); // 4 min
const CC_VERSION = process.env.CC_VERSION ?? "2.0.0";
const USER_AGENT = `claude-code/${CC_VERSION}`;
const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ??
  "http://localhost:3000,https://subscription-agent-five.vercel.app")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let cache = null; // { data, at }

function credentialsPath() {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

async function readAccessToken() {
  let raw;
  try {
    raw = await fs.readFile(credentialsPath(), "utf8");
  } catch {
    throw new Error(
      `Could not read ${credentialsPath()}. Open a terminal and run "claude" (Claude Code) once and log in so the credentials file is created.`,
    );
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Credentials file is not valid JSON.");
  }
  const token = json?.claudeAiOauth?.accessToken;
  if (!token) {
    throw new Error("claudeAiOauth.accessToken not found. Log in via Claude Code first.");
  }
  return token;
}

async function fetchUpstream() {
  const token = await readAccessToken();
  const resp = await fetch(ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      // Required: requests without a claude-code User-Agent get aggressively
      // rate-limited (persistent 429). Impersonating the harness is the only
      // way the endpoint lets traffic through.
      "User-Agent": USER_AGENT,
    },
  });
  if (resp.status === 401) {
    return {
      error: "token_expired",
      message:
        'Claude Code token expired — run any "claude" command in a terminal to refresh it, then retry.',
    };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return {
      error: "upstream",
      status: resp.status,
      message: `Anthropic returned ${resp.status}` + (body ? `: ${body.slice(0, 200)}` : ""),
    };
  }
  const data = await resp.json();
  return {
    five_hour: {
      utilization: data?.five_hour?.utilization ?? null,
      resets_at: data?.five_hour?.resets_at ?? null,
    },
    seven_day: {
      utilization: data?.seven_day?.utilization ?? null,
      resets_at: data?.seven_day?.resets_at ?? null,
    },
  };
}

async function getUsage() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ...cache.data, cached: true, refreshed_at: new Date(cache.at).toISOString() };
  }
  const result = await fetchUpstream();
  // Only cache successful responses.
  if (!result.error) cache = { data: result, at: Date.now() };
  return { ...result, refreshed_at: new Date().toISOString() };
}

function corsOrigin(requestOrigin) {
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return ALLOWED_ORIGINS[0] ?? "*";
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin(req.headers.origin));
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "claude-usage-bridge" }));
    return;
  }

  if (req.url === "/usage" && req.method === "GET") {
    try {
      const data = await getUsage();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bridge_error", message: String(e?.message || e) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`claude-usage-bridge listening on http://${HOST}:${PORT}`);
  console.log(`  credentials file: ${credentialsPath()}`);
  console.log(`  allowed origins:  ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`  cache TTL:        ${CACHE_TTL_MS}ms`);
  console.log(`  User-Agent:       ${USER_AGENT}`);
});
