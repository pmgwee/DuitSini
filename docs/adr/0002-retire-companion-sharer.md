# ADR-0002 — Retire the legacy companion sharer and its shared-secret fallback

- **Status:** Accepted (2026-07-26)
- **Decided in:** `/grill-with-docs` session on Candidate 1
- **Related:** ADR-0001 (carriage), Candidate 2 of the 2026-07-26 architecture review

## Context

`companion/claude-usage-bridge.mjs` (624 lines) is the older, shared-secret, single-user
implementation of the local bridge script. The adversarial review confirmed it is a **second
source of truth**, not a deprecated artifact:

- Its shared-secret auth path is **still live in production** as the legacy fallback at
  `lib/claude-usage/bridge-auth.ts:67` (`bridgeSecretAuthorized(header) && CLAUDE_BRIDGE_USER_ID`).
- It has **diverged from the canonical `SOURCE` sharer on every behavioral axis**: auth
  (shared `BRIDGE_SECRET` env vs per-user `cub_` token), sources (mutually-exclusive Claude/GLM
  vs simultaneous multi-stream), 429 strategy (single 300s-cap ladder vs v6 quiet periods),
  refresh trigger (in-memory + 45s floor vs persisted `.sharer-state` + on-demand), cadence
  (default 60s vs 300s), and identity banner (absent vs v6.1 email echo).
- Two helpers are **duplicated near-verbatim**: `retryMsFrom` and the atomic
  temp-write-rename credential write.
- The README and the ingest route's own header comment **describe the legacy shared-secret
  model as current**, which no longer matches the canonical per-user-token path.

## Decision

Retire the companion entirely. Consolidate to one canonical sharer with **per-user `cub_` tokens
as the only auth path**:

1. Delete `companion/claude-usage-bridge.mjs` (and `companion/README.md`'s companion-specific
   content).
2. Remove the legacy shared-secret fallback branch in `lib/claude-usage/bridge-auth.ts`
   (`bridgeSecretAuthorized` + the `CLAUDE_BRIDGE_USER_ID` return) and the now-unused
   `bridgeSecretAuthorized` helper if nothing else consumes it.
3. Fix the stale documentation: the ingest route header comment and any README section that
   presents the shared-secret model as live.

## Consequences

**Positive**

- One auth path, one source of truth — OAuth/credential handling changes land in one place.
- The two near-verbatim duplicated helpers collapse into the canonical modules from ADR-0001.
- Removes a dormant, undocumented auth surface (the shared secret + pinned user id).
- Documentation stops mis-describing the system.

**Negative / costs**

- The owner's legacy single-user shared-secret path no longer functions. (Accepted: the owner
  confirmed in the grilling session that this path is not relied upon.)
- Any external push still using `BRIDGE_SECRET` will receive a 401 once the fallback is removed.
  This is intentional and final; no migration shim.

**Invariant preserved**

- The canonical per-user `cub_` token path (`resolveBridgeUserId`) is unaffected. The token
  contract, minting, and resolution seam are unchanged.

## Alternatives considered

- **Keep the companion as a thin adapter** over the new bundled sharer (inject shared-secret
  auth). Rejected: it would preserve a path the owner does not use, at the cost of an extra
  adapter and continued divergence risk.
- **Leave it, only fix the docs.** Rejected: does not resolve the second-source-of-truth
  friction or remove the dormant auth surface — the two problems that made Candidate 2 "Strong."
