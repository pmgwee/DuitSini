# ADR-0003 — Sharer modules are pure policy cores behind a thin orchestrator

- **Status:** Accepted (2026-07-26)
- **Decided in:** `/grill-with-docs` session on Candidate 1
- **Related:** ADR-0001 (carriage)

## Context

ADR-0001 moves the sharer's behavior into real TypeScript modules and makes the interface the
test surface. The open question was *how to cut the modules*: the v3→v7 bug history lives in
pure policy logic (the 429 ladders, the refresh gates, the cadence clamp, the credential walk
order, `retryMsFrom`), but the script also holds stateful coordination (the `.sharer-state.json`
gates) and I/O (credential files, `fetch`).

## Decision

Cut **small, stateless, pure-policy modules** for every decision that can be expressed as a
function of inputs → decision, and leave **state and I/O in one thin orchestrator** that composes
them. Concretely the family: `BackoffLadder`, `RefreshPolicy`, `CadenceClamp`,
`CredentialWalkOrder`, `RetryMath` (pure); the loop/state/fs/fetch stay in the orchestrator.

## Consequences

**Positive**

- Each policy module is unit-testable through its interface alone — **no `fs`/`fetch` doubles
  required** to test the logic where the actual incidents lived. This is the testability win
  that motivated Candidate 1.
- Locality: a change to "how the 429 ladder escalates" touches one pure module, not a string.
- The orchestrator stays thin (state + I/O + composition), so its own test surface is small.

**Negative / costs**

- More modules than a "stateful manager" alternative — higher file count, more named interfaces
  to learn.
- The orchestrator still needs integration tests for state/fs/fetch wiring (the pure modules
  don't cover that); those tests are fewer and focused on glue, not policy.

## Alternatives considered

- **Fewer stateful managers** (e.g. one `RefreshManager` owning policy + state + I/O): fewer
  modules, but unit tests need `fs`/`fetch` doubles → integration-shaped, defeating the "test the
  policy in isolation" goal. Rejected.
- **One monolithic `SharerEngine`**: deep by ratio, but testing it is equivalent to testing
  today's whole script — does not move the "interface is the test surface" needle. Rejected.

## Open follow-up

- The exact module list and each interface's signature (next grilling question — may use the
  `/codebase-design` design-it-twice pattern to explore alternatives before locking).
- The cross-cutting `protocol` module (snapshot schema + cadence clamp) shared with the API
  routes — its location is decided alongside the module list.
