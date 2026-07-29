# ADR-0001 — Extract the Claude-usage sharer into bundled TypeScript modules

- **Status:** Accepted (2026-07-26)
- **Decided in:** `/grill-with-docs` session on Candidate 1 of the 2026-07-26 architecture review
- **Supersedes:** the v3→v7 single-template-literal carriage in `lib/bridge/member-bridge-template.ts`

## Context

The Claude-usage sharer — the personalized script each member downloads and runs to broadcast
their Claude Pro / GLM usage — is the repo's #1 change hot spot (17 commits in the last 100,
with a documented v3→v7 incident history of 429 lockouts and ~8h token-expiry failures).

Today the entire program is an **825-line `SOURCE` template literal** inside
`lib/bridge/member-bridge-template.ts`. The exported `buildMemberBridge(cfg) → string`
substitutes four identity placeholders (ingestUrl, pullUrl, token, email) and nothing else.

An adversarial architecture review (2026-07-26, six independent verifications) confirmed:

- **By ratio the module is deep** (small interface : large implementation). The friction is not
  shallowness — it is **opacity**. Every behavioral constant (`PUSH_MS`, `REFRESH_COOLDOWNS_MS`,
  the usage-429 `quiet` ladder, `EXPIRY_BUFFER_MS`, the credential walk order) is baked as a
  literal *inside the string*, unreachable from any interface.
- **The state machine is untestable through any current interface.** The script runs as an IIFE
  on import, exports nothing, and there is no test runner in the repo. The only testable
  function (`buildMemberBridge`) tests string substitution, not behavior. "The interface is the
  test surface" fails completely.
- **The template-literal hosting dictates the embedded program's surface syntax** — no
  backticks, no `${}`, no backslashes (CLAUDE.md "CRITICAL constraint"). This is anti-leverage
  radiating from a carriage choice.

## Decision

Move the behavioral logic out of the template literal into **real, exported TypeScript modules**
that are the source of truth. Introduce an **esbuild build-time bundle** that inlines those
modules into a single served `.mjs`. `buildMemberBridge` shrinks to identity substitution on the
pre-bundled output.

Concretely:

- Author modules such as a refresh policy, a 429-backoff ladder, a snapshot schema (shared
  protocol), and a credential walker as ordinary typed TS — backticks and template literals
  permitted; the syntax tax is gone.
- The modules are importable, so the state machine becomes unit-testable through its interface.
- `esbuild` bundles them at **build time** (not request time) into a single self-contained
  `.mjs` template carrying only the four identity placeholders.
- `/api/bridge/mac` continues to serve the script at request time, substituting identity into
  the pre-bundled file.

## Consequences

**Positive**

- The interface becomes the test surface — the refresh/429 state machine can be tested directly.
- Behavioral constants become reachable, named values rather than opaque literals.
- The snapshot/stream shape can be declared once in a shared protocol module imported by both
  the sharer bundle and the ingest/live routes (dissolves the four-way shape duplication:
  SOURCE producer, ingest Zod, live `StreamRow`, frontend `UsageStream`).
- The no-backticks/`${}`/backslashes authoring constraint is eliminated.
- Unlocks retiring the legacy `companion/claude-usage-bridge.mjs` second source of truth
  (tracked separately).

**Negative / costs**

- New dev dependency: `esbuild` (lightweight, but a real new build tool).
- A new build step (`pnpm build:sharer` or a `prebuild` hook) that emits the bundled script;
  the bundled output must be kept in sync (CI check or commit-the-artifact policy — to be
  decided).
- Build-time artifact now sits between source and the served script — a debugging indirection
  that did not exist before.

**Invariant preserved**

- The member-facing contract is unchanged: one self-contained `.mjs`, manually run, visible
  window — no daemon / auto-start / tray / hidden modes (per project memory
  `sharer-manual-run-preference`). The four identity placeholders and the token/URL contract
  remain stable so members running older sharer versions are not broken.

## Alternatives considered

- **One real `.ts` file + light single-file transform** — simpler than multi-module, but yields
  coarser module boundaries and weaker locality; the multi-module bundle was preferred for
  leverage and test granularity.
- **Extract pure helpers only, leave behavior in the template literal** — cheapest, but does
  not fix the opacity (the real coordination stays unreachable in the string); rejected because
  it fails the "interface is the test surface" bar that motivated the candidate.

## Open follow-ups (tracked in this grilling session)

- Companion fate (retire vs. keep as adapter) — forthcoming ADR.
- Exact module interfaces and boundaries.
- Shared protocol module location and shape.
- Test runner selection.
- Member migration / rollout path.
