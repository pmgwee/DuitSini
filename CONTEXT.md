# CONTEXT — project glossary

This is the canonical domain vocabulary for `subscription-agent` (duitsini). All engineering
skills (`/grill-with-docs`, `/improve-codebase-architecture`, `/domain-modeling`, code review)
use these terms so that issues, refactors, and tests don't drift into synonyms the project
doesn't use.

Terms are added lazily as they get resolved in design conversations. If a concept you need is
missing, that's a signal — either reconsider the language, or note the gap for `/domain-modeling`.

## Core domain (financial / calendar)

- **Subscription** — a recurring bill a member tracks. Stored in major units (dollars, not
  cents). Has an anchor date, `billingCycle`, and `intervalCount`.
- **Charge series** — the recurring charge dates derived from an anchor + cycle. Computed by the
  engine in `lib/domain/renewal.ts` (`nextChargeOnOrAfter`, `chargesInRange`).
- **BillingCycle** — the cycle unit: weekly, monthly, quarterly, semiannual, annual, or
  `custom_days`/`custom_months` (the latter honor `intervalCount`; the fixed cycles ignore it).
- **MYR-home** — the app normalizes every currency to ringgit for totals. Convert per-sub at full
  precision, sum, round once. See `lib/domain/fx.ts` (`toMYR`).

## Claude-usage bridge (the sharer subsystem)

- **Sharer** — the personalized `.mjs` script each member downloads and runs to broadcast their
  Claude Pro / GLM usage to the dashboard. Manually run, visible window — never daemonized.
- **Snapshot** — one push payload: `{ window, limit, provider, streams }`. The shape is defined
  once in `lib/claude-usage/protocol.ts` (Zod `snapshotSchema`) and shared by the sharer, the
  ingest route, the live route, and the frontend. (ADR-0004)
- **UsageStream** — one element of `snapshot.streams`: a single source's usage (Claude Pro or
  GLM) with its own window/limit/used values. (ADR-0004)
- **`cub_` token** — the per-user bridge token that authenticates a push. **The token IS the
  identity** — every push lands on the token owner's row regardless of the machine's Google
  login. (memory: `bridge-token-identity`)
- **BackoffLadder** — the pure module (`lib/bridge/sharer/backoff.ts`) that decides how long a
  source pauses after a 429 / 5xx / reauth. Two distinct ladders: the usage-endpoint quiet ladder
  `[15, 30, 60]` min and the refresh-endpoint ladder `[15, 30, 60, 120]` min. (ADR-0004)
- **CadenceClamp** — the pure module (`lib/bridge/sharer/cadence.ts`) bounding push cadence to
  `[120, 3600]` s (default 300 s) and deriving the freshness window. Single source for a clamp
  that was previously duplicated in the sharer and the live route. (ADR-0004)
- **RefreshPolicy** — the pure module (`lib/bridge/sharer/refresh-policy.ts`) deciding whether to
  spend a refresh POST: use the token as-is until 5 min before expiry (or a real 401), gated by
  ≥45 s between attempts and ≥15 min after a success. Returns a `RefreshDecision`. (ADR-0004)
- **RefreshDecision** — `{ action: 'use' | 'refresh'; reason }`, the output of `RefreshPolicy`.
  (ADR-0004)
- **CredentialWalkOrder** — the pure order in which credential sources are tried (dedicated dirs
  → macOS Keychain → `~/.claude`), in `credentials.ts` as `candidateWalk`. (ADR-0004)
- **SharerState** — the persisted `.sharer-state.json` holding cooldowns, settle windows, and
  refresh gates across restarts. Owned by the orchestrator; passed as input to `RefreshPolicy`.
- **Orchestrator** — `lib/bridge/sharer/index.ts`, the thin stateful module that owns state +
  `safeFetch` + the loop and composes the five pure modules. What esbuild bundles into the served
  `.mjs`. (ADR-0004)

## Two limiters on usage queries (historical, resolved)

- **Usage-429 volume window** — a server-side rolling volume limit on the usage endpoint keyed to
  the account. Solved by the 300 s cadence (v6). (memory: `sharer-usage-query-architecture`)
- **~8 h token-expiry hard-401** — the usage endpoint rejects an access token the moment its
  `expiresAt` passes. Solved by on-demand refresh (v7). (memory: `sharer-usage-query-architecture`)
