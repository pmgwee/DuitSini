/**
 * Sharer entry — what esbuild bundles into the served `.mjs` (ADR-0001 / ADR-0004).
 *
 * ⚠ SLICE-1 SKELETON. This minimal entry exists to PROVE THE BUILD PIPELINE:
 * esbuild bundles TS modules into one self-contained `.mjs`; the four identity
 * placeholders survive the bundle verbatim; the output runs under plain node.
 *
 * The real orchestrator — the push loop, `.sharer-state.json`, `safeFetch`, the
 * GLM / cc-switch source reader, the credential walk — is extracted in later
 * slices and REPLACES this skeleton. `/api/bridge/mac` is NOT rewired here until
 * the full orchestrator lands; the running system still serves the v7 SOURCE.
 */
import { proUsage429Hold } from "./backoff";

// Identity is substituted at request time by buildMemberBridge, exactly as it
// substitutes the v7 SOURCE today. These four literals MUST survive the esbuild
// bundle verbatim — do not rename, interpolate, or compute them.
export const INGEST_URL = "__INGEST_URL__";
export const PULL_URL = "__PULL_URL__";
export const BRIDGE_TOKEN = "__BRIDGE_TOKEN__";
export const ACCOUNT_EMAIL = "__ACCOUNT_EMAIL__";

// Slice-1 skeleton main. In the real orchestrator these feed `fetch()` and the
// `Authorization` header; here they are echoed only to prove the placeholders
// survived the bundle and are reachable after identity substitution.
function main() {
  const cfg = {
    ingestUrl: INGEST_URL,
    pullUrl: PULL_URL,
    token: BRIDGE_TOKEN,
    email: ACCOUNT_EMAIL,
  };
  console.log("Claude usage sharer — account: " + (cfg.email || "(unknown account)"));
  console.log("endpoints: ingest=" + cfg.ingestUrl + "  pull=" + cfg.pullUrl);
  // Proves a pure policy module is bundled in and live.
  console.log("pro usage-429 first quiet hold: " + proUsage429Hold(1, undefined, 0) + " ms");
}

main();
