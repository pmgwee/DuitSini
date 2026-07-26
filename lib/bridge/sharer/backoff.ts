/**
 * Pure backoff / quiet-period math for the sharer (ADR-0004).
 *
 * Extracted VERBATIM from the v7 logic in the sharer's SOURCE — specifically
 * `pauseSource` (usage-429 handling) and `attemptRefresh` (refresh-429 /
 * reauth / 5xx handling). All randomness is passed in as a `jitterMs` argument
 * so these functions are deterministic and unit-testable; the orchestrator
 * supplies `Math.floor(Math.random() * N)` when it calls them.
 *
 * Two limiters, two ladders (see CONTEXT.md):
 *   - usage-429 quiet ladder `[15, 30, 60]min` — applies to the `pro` source
 *     only; the `glm` source uses `glmRetryHold` / `glmBackoffHold` instead.
 *   - refresh-429 ladder `[15, 30, 60, 120]min` — the token-refresh endpoint.
 *
 * These functions return a hold DURATION (ms). The orchestrator turns a hold
 * into a `nextAt` (`now + hold`) and, for cooldown/reauth/5xx codes, pads an
 * absolute blocked-until by `COOLDOWN_NEXTAT_PAD_MS` (2s) — that pad lives
 * with the orchestrator's scheduling, not in the pure math.
 */

/** Floor for any 429 retry. `retry-after: 0` must not spin us straight back in. */
export const MIN_429_BACKOFF_MS = 60_000;

/** Usage-endpoint 429 quiet ladder (pro source), in ms. v6. */
export const USAGE_429_QUIET_MS = [900_000, 1_800_000, 3_600_000] as const;

/** Refresh-endpoint 429 cooldown ladder, in ms. v3 discipline, retained in v7. */
export const REFRESH_COOLDOWNS_MS = [900_000, 1_800_000, 3_600_000, 7_200_000] as const;

/** A dead / rotated refresh token: only a re-login can fix it. Hold long. */
export const REAUTH_BLOCK_MS = 3_600_000;

/** Token service unwell (5xx): modest hold; fast-retrying would be noise. */
export const TOKEN_5XX_BLOCK_MS = 600_000;

/** Cap on the GLM source's retry-after-based next hold (ms). */
export const GLM_RETRY_CAP_MS = 600_000;

/** Cap on the GLM source's exponential backoff (ms). */
export const GLM_BACKOFF_CAP_MS = 300_000;

/** Pad added to an absolute blocked-until when scheduling the next attempt. */
export const COOLDOWN_NEXTAT_PAD_MS = 2_000;

const ladderAt = (ladder: readonly number[], streak: number): number =>
  ladder[Math.min(streak, ladder.length) - 1];

/**
 * Usage-429 quiet hold for the `pro` source ONLY (GLM uses `glmRetryHold` /
 * `glmBackoffHold`). The server's `retry-after` wins when it asks for more; the
 * ladder escalates with streak. `jitterMs` is the random 0–30 000 ms component
 * the orchestrator draws (pauseSource: `Math.floor(Math.random() * 30000)`).
 *
 * pauseSource: `hold = Math.max(e.retryMs || 0, quiet[min(streak, len) - 1]); nextAt = now + hold + jitter`.
 */
export function proUsage429Hold(
  streak: number,
  retryMs: number | undefined,
  jitterMs: number,
): number {
  return Math.max(retryMs || 0, ladderAt(USAGE_429_QUIET_MS, streak)) + jitterMs;
}

/**
 * GLM 429 hold when the server sent a usable `retry-after`. Capped at
 * `GLM_RETRY_CAP_MS`, floored at `MIN_429_BACKOFF_MS`, with a +3 s offset and
 * `jitterMs` (0–4 000 ms) inside the floor/cap. Called only when `retryMs > 0`.
 *
 * pauseSource: `Math.min(600000, Math.max(MIN_429_BACKOFF_MS, retryMs + 3000 + jitter))`.
 */
export function glmRetryHold(retryMs: number, jitterMs: number): number {
  return Math.min(GLM_RETRY_CAP_MS, Math.max(MIN_429_BACKOFF_MS, retryMs + 3_000 + jitterMs));
}

/**
 * GLM 429 exponential backoff when no usable `retry-after`. Doubles the
 * previous backoff (or `PUSH_MS` on the first hit), floored at
 * `MIN_429_BACKOFF_MS`, capped at `GLM_BACKOFF_CAP_MS`. No jitter.
 *
 * pauseSource: `Math.min(300000, Math.max(MIN_429_BACKOFF_MS, (prevBackoff || pushMs) * 2))`.
 */
export function glmBackoffHold(prevBackoff: number | undefined, pushMs: number): number {
  return Math.min(GLM_BACKOFF_CAP_MS, Math.max(MIN_429_BACKOFF_MS, (prevBackoff || pushMs) * 2));
}

/**
 * Refresh-endpoint 429 hold. The server's `retry-after` wins when longer; the
 * ladder escalates with streak; `jitterMs` is the random 0–180 000 ms component
 * (attemptRefresh: `Math.floor(Math.random() * 180000)`).
 *
 * attemptRefresh: `hold = Math.max(e.retryMs || 0, ladder[min(streak, len) - 1]) + jitter`.
 */
export function refresh429Hold(
  streak: number,
  retryMs: number | undefined,
  jitterMs: number,
): number {
  return Math.max(retryMs || 0, ladderAt(REFRESH_COOLDOWNS_MS, streak)) + jitterMs;
}

/** Hold for a dead refresh token (4xx). Only a re-login clears it. */
export function reauthHold(): number {
  return REAUTH_BLOCK_MS;
}

/** Hold for a token-service 5xx. */
export function token5xxHold(): number {
  return TOKEN_5XX_BLOCK_MS;
}
