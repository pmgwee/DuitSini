# ADR-0005 — Sharer refactor: implementation & rollout decisions

- **Status:** Accepted (2026-07-26)
- **Decided in:** `/grill-with-docs` session on Candidate 1
- **Related:** ADR-0001 (carriage), ADR-0004 (modules)

This ADR bundles the four implementation-level decisions that follow the architectural ones
(ADR-0001 → 0004).

## 1. Bundled-artifact commit policy (Q5)

**Decision:** the esbuild-generated `.mjs` is **committed to the repo**. A `pnpm build:sharer`
script (wired into `prebuild` / `next build`) regenerates it; CI asserts the artifact is fresh
(fails if source modules changed without regeneration). `/api/bridge/mac` reads the committed
file and performs identity substitution at request time.

**Why over build-at-deploy:** deterministic serving (no build dependency at request time), local
dev works without a build, and — most important for a script members download and run — PR
reviewers see the exact shipped-script diff (esbuild emits non-minified output). The "generated
code in git" cost is contained by the CI freshness check.

## 2. Test runner (Q6)

**Decision:** **Vitest**. First-class TypeScript + ESM, minimal config, fast, and aligned with
the esbuild/Vite tooling family chosen in ADR-0001. The five pure policy modules
(`backoff`, `retry`, `cadence`, `refresh-policy`, `credentials`) get unit tests with no
`fs`/`fetch` doubles; the orchestrator gets a smaller set of integration tests for the
state/fs/fetch wiring.

## 3. Member migration / rollout

**Decision:** **no forced migration.** The member-facing contract is unchanged by ADRs 0001–0004
— the same four identity placeholders, the same `cub_` token, the same ingest/pull URLs. Members
running the current v7 sharer keep working unchanged; they pick up the new bundled script the
next time they download (re-run the mac command). The dashboard's realtime read is unaffected.

The new script must be **behaviorally identical** to v7 at cutover (see §4). Nothing is asked of
existing members.

## 4. Behavior-freeze discipline (Q7 — proposed, not a fork)

**Decision:** the extraction is a **pure refactor first**, in three disciplined steps:

1. **Move, don't change.** Every behavioral constant (`PUSH_MS`, the two 429 ladders,
   `EXPIRY_BUFFER_MS`, `REFRESH_MIN_*`, the credential walk order, the `[120, 3600]` cadence
   clamp) relocates **verbatim** into the new modules; control flow is preserved.
2. **Characterize before improving.** The first tests are golden/characterization tests on the
   pure modules using the actual v7 constants — they pin the current behavior, including the
   incident-hardened corners, so the extraction is provably behavior-preserving.
3. **Only then improve.** Any logic change is a separate, later commit on top of the frozen +
   tested baseline, with its own ADR if load-bearing.

**Why:** the v3→v7 history is incident-driven and the state machine is subtle. Mixing the
mechanical extraction with behavioral changes would make a regression unattributable. Freeze
first, test, then evolve.

## Consequence

These four decisions make ADRs 0001–0004 implementable without surprises: the build is
deterministic and reviewable, the tests have a runner, members are unaffected, and the extraction
is provably behavior-preserving.
