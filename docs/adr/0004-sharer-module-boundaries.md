# ADR-0004 — Sharer module boundaries and interfaces

- **Status:** Accepted (2026-07-26)
- **Decided in:** `/grill-with-docs` session on Candidate 1
- **Related:** ADR-0001 (carriage), ADR-0003 (granularity)

## Context

ADR-0003 committed to pure-policy cores behind a thin orchestrator. This ADR pins the concrete
modules, their files, and their interfaces — the contract the unit tests will pin down. The
decomposition maps 1:1 to the behavioral logic the adversarial review located inside the `SOURCE`
string, and consolidates every cross-cutting duplication the review flagged.

## Decision

Seven modules. Five are stateless pure policies; one is a cross-cutting protocol module shared
with the API routes and frontend; one is the stateful orchestrator that esbuild bundles into the
served `.mjs`.

### Pure policy modules — `lib/bridge/sharer/*.ts`

- **`backoff.ts`**
  - `quietFor(kind: 'usage-429' | '5xx' | 'reauth', streak: number, retryAfterMs?: number): number`
    — usage-endpoint quiet ladder `[15, 30, 60]` min (`retry-after` wins if longer); fixed holds for 5xx/reauth.
  - `refreshCooldownMs(streak: number, retryAfterMs?: number): number`
    — refresh-endpoint ladder `[15, 30, 60, 120]` min.
- **`retry.ts`**
  - `retryMsFrom(headers: Record<string, string>, nowMs: number): number`
    — parse `retry-after` (seconds) or `reset` (unix epoch), else `0`. The single home for the
    parser duplicated in both scripts.
- **`cadence.ts`**
  - `clampPushSeconds(secs: number): number` — `min(3600, max(120, secs))`.
  - `freshnessWindowMs(pushSeconds: number): number` — `2 * clampPushSeconds(pushSeconds) * 1000 + 60_000`.
  - Dissolves the **2×** cadence-clamp duplication (sharer `loadPushMs` + live `staleAfterMs`).
- **`refresh-policy.ts`**
  - `shouldRefresh(input: { expiresAtMs: number; nowMs: number; state: SharerState }): RefreshDecision`
    — returns `{ action: 'use' | 'refresh'; reason }`. Encodes: use token as-is until
    `EXPIRY_BUFFER_MS` (5 min) before expiry; ≥45 s between attempts; ≥15 min after a successful
    refresh; settle windows.
- **`credentials.ts`**
  - `candidateWalk(config: EnvConfig): CandidateSource[]` — the walk order (dedicated dirs → macOS Keychain → `~/.claude`).
  - `oauthEntryOf(parsedFile: unknown): OAuthEntry | null` — dual key-spelling resolver (`claudeAiOauth` ∥ `claude.ai_oauth`).
  - `shouldAdoptFromDisk(entry: OAuthEntry, staleExpMs: number, nowMs: number): boolean`.

### Cross-cutting protocol module — `lib/claude-usage/protocol.ts`

- `snapshotSchema` (Zod) for `{ window, limit, provider, streams: streamSchema[] }` and
  `streamSchema`; exported `Snapshot` / `UsageStream` types derived from the schema.
- Cadence constants `PUSH_SECONDS_MIN = 120`, `PUSH_SECONDS_MAX = 3600`,
  `PUSH_SECONDS_DEFAULT = 300`, imported by `cadence.ts` and the live/ingest routes.
- **Consumers:** sharer bundle (producer) · ingest route (`safeParse`) · live route (`StreamRow`
  → `Snapshot`) · frontend (`UsageStream`). Dissolves the **4×** snapshot-shape duplication.

### Orchestrator — `lib/bridge/sharer/index.ts`

- Owns `.sharer-state.json` read/write, the `safeFetch` adapter (`connection: close`, 3× retry,
  12 s abort), the cadence timer, the identity banner (`__ACCOUNT_EMAIL__`), and the GLM /
  cc-switch source reader.
- Composes the five pure modules + the protocol schema to build and push snapshots.
- esbuild inlines this into the served `.mjs`; `buildMemberBridge` performs identity
  substitution on the bundled output.

## Consequences

**Positive**

- The five policy modules + `retryMsFrom` are unit-testable with **no `fs`/`fetch` doubles**.
- The snapshot/stream shape and the cadence clamp each have exactly one home.
- The frontend, both API routes, and the sharer share one Zod schema — a shape change propagates
  everywhere via the type system.

**Negative / costs**

- `protocol.ts` is imported across subsystems (bridge + API + frontend): a breaking change to the
  schema ripples to all four consumers. This is intended (single source of truth) but raises the
  stakes on schema versioning.
- The orchestrator still needs integration tests for the state / fs / fetch wiring the pure
  modules do not cover.

## Refinement — slice 1 (2026-07-26)

The verbatim read of the v7 source revealed the pure modules must take their
**randomness as an injected `jitterMs` argument** (the source draws
`Math.floor(Math.random() * N)` inline at every backoff site). To stay pure and
deterministic, `backoff.ts` accepts `jitterMs` and the orchestrator supplies
`Math.random()`. This is the reason the ADR-0004 interface sketch listed
`retryAfterMs?` but the implemented `proUsage429Hold` / `refresh429Hold` /
`glmRetryHold` signatures also take a `jitterMs`.

The read also confirmed the source-specific strategy the sketch glossed: the
usage-429 quiet ladder applies to the **`pro` source only**; `glm` uses a
separate retry-after-capped / exponential path. `backoff.ts` therefore exports
`proUsage429Hold`, `glmRetryHold`, and `glmBackoffHold` as distinct functions
rather than one parameterized `quietFor`.

Landed in slice 1: `lib/claude-usage/protocol.ts`, `lib/bridge/sharer/backoff.ts`,
and 26 characterization tests (all green). Running system unchanged — the slice
is additive; route/orchestrator rewiring and companion retirement come later.

## Open follow-ups

Resolved by ADR-0005 (test runner = Vitest; artifact committed; member migration
none-forced; behavior-freeze = move-then-characterize-then-improve). Remaining
implementation work: the esbuild `build:sharer` wiring + freshness check, the
remaining pure modules (`retry`, `refresh-policy`, `credentials`), the
orchestrator extraction, route/frontend adoption of `protocol.ts`, and the
companion retirement (ADR-0002).
