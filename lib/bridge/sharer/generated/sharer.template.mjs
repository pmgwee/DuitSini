#!/usr/bin/env node

// lib/bridge/sharer/backoff.ts
var USAGE_429_QUIET_MS = [9e5, 18e5, 36e5];
var ladderAt = (ladder, streak) => ladder[Math.min(streak, ladder.length) - 1];
function proUsage429Hold(streak, retryMs, jitterMs) {
  return Math.max(retryMs || 0, ladderAt(USAGE_429_QUIET_MS, streak)) + jitterMs;
}

// lib/bridge/sharer/index.ts
var INGEST_URL = "__INGEST_URL__";
var PULL_URL = "__PULL_URL__";
var BRIDGE_TOKEN = "__BRIDGE_TOKEN__";
var ACCOUNT_EMAIL = "__ACCOUNT_EMAIL__";
function main() {
  const cfg = {
    ingestUrl: INGEST_URL,
    pullUrl: PULL_URL,
    token: BRIDGE_TOKEN,
    email: ACCOUNT_EMAIL
  };
  console.log("Claude usage sharer \u2014 account: " + (cfg.email || "(unknown account)"));
  console.log("endpoints: ingest=" + cfg.ingestUrl + "  pull=" + cfg.pullUrl);
  console.log("pro usage-429 first quiet hold: " + proUsage429Hold(1, void 0, 0) + " ms");
}
main();
export {
  ACCOUNT_EMAIL,
  BRIDGE_TOKEN,
  INGEST_URL,
  PULL_URL
};
