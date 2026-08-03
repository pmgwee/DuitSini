import {
  glmBackoffHold,
  glmRetryHold,
  codexUsage429Hold,
  proUsage429Hold,
} from "../../lib/bridge/sharer/backoff";
import {
  API_CACHE_MS,
  CLIENT_VERSION,
  DEFAULT_PUSH_MS,
  LOCAL_ESTIMATE_MS,
  MIN_GAP_MS,
  claudeCredCandidates,
  clampPushMs,
  generalTailStart,
} from "./config";
import { AllRejectedError, NoCredentialsError, fetchProSnapshot } from "./collectors/claude-oauth";
import { ClaudeCliRenewalManager } from "./collectors/claude-cli-renewal";
import { LocalUsageEstimator } from "./collectors/claude-local";
import {
  AllCodexCredentialsRejectedError,
  NoCodexCredentialsError,
  currentCodexCredentialFingerprint,
  fetchCodexSnapshot,
} from "./collectors/codex";
import {
  detectProvider,
  fetchGlmUsage,
  safeProvider,
  type DetectedProvider,
} from "./collectors/glm";
import type { Store } from "./store";
import { safeFetch } from "./net";
import type { UsageTracker } from "./tracker";
import type { Snapshot, UsageStream } from "./types";

/**
 * Collection loop.
 *
 * Two rules carried over from the sharer, both earned the hard way:
 *
 *  - SOURCES ARE ISOLATED. A rate-limited Claude must never stall the GLM push
 *    and vice versa; each keeps its own `nextAt`.
 *  - A 429 STOPS that source rather than retrying it faster. The limiter on the
 *    usage endpoint is a rolling volume window keyed to the account, so pressing
 *    harder is precisely wrong.
 *
 * General Claude Code credentials remain read-only. Dedicated secondary
 * profiles may renew through the installed official Claude CLI only.
 */

export type Status =
  | { kind: "idle" }
  | { kind: "ok"; at: number; sourceLabel: string | null }
  | { kind: "estimate"; at: number; reason: string }
  | { kind: "paused"; until: number; reason: string }
  | { kind: "error"; reason: string };

export interface SchedulerDeps {
  store: Store;
  /** Resolves the current bridge token, minting one if needed. Null = not signed in. */
  getToken: () => Promise<string | null>;
  ingestUrl: () => string;
  onStatus: (s: Status) => void;
  log: (line: string) => void;
  /** Durable forensic journal for usage/refresh events. */
  tracker: UsageTracker;
}

const jitter = (n: number) => Math.floor(Math.random() * n);

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly local = new LocalUsageEstimator();
  private readonly renewal: ClaudeCliRenewalManager;
  private pushMs = DEFAULT_PUSH_MS;
  private lastPushAt = 0;
  private lastApiAt = 0;
  private lastApiSnapshot: Snapshot | null = null;
  private lastLocalAt = 0;
  private activeSourceLabel: string | null = null;
  private lastCodexSnapshot: Snapshot | null = null;
  private lastCodexAt = 0;
  private running = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.renewal = new ClaudeCliRenewalManager({
      tracker: deps.tracker,
      initialState: deps.store.get().cliRenewal,
    });
  }

  async start(pushSeconds?: number): Promise<void> {
    if (pushSeconds) this.pushMs = clampPushMs(pushSeconds * 1000);
    this.local.loadCalibration(this.deps.store.get().calibration);
    const claude = this.deps.store.snapshot("claude_pro");
    if (claude) {
      this.lastApiSnapshot = this.snapshotOf(claude.stream);
      this.lastApiAt = claude.observedAt;
    }
    const codex = this.deps.store.snapshot("codex");
    if (codex) {
      this.lastCodexSnapshot = this.snapshotOf(codex.stream);
      this.lastCodexAt = codex.observedAt;
    }
    // Prime the offline estimate immediately so the first paint is never empty.
    await this.refreshLocal();
    this.timer = setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Manual refresh from the UI. Still respects MIN_GAP_MS and any cooldown. */
  async pullNow(): Promise<void> {
    await this.tick(true);
  }

  /**
   * Path of the dedicated Claude profile whose login is currently dead (renewal
   * exhausted the streak), if any. Powers the one-click "Renew sign-in" action:
   * the main process spawns the official CLI's full browser flow against this
   * profile's config dir, and the next cycle picks up the new credentials via
   * `externalReloginDetected`. Returns null when the login is healthy.
   */
  claudeProRenewalTarget(): string | null {
    // Prefer a profile the scheduler already knows is dead. Otherwise target
    // the first dedicated profile — the "Renew sign-in" button exists to
    // re-sign-in the dedicated Claude Pro profile whether it is streak-dead,
    // rejected, or simply EMPTY (no creds at all → NoCredentialsError →
    // auth_stale, but the streak never accrues because there was no token to
    // attempt). Without this fallback the button silently no-ops on the most
    // common stale situation.
    const dead = this.renewal.terminalPath();
    if (dead) return dead;
    const paths = claudeCredCandidates();
    return paths.slice(0, generalTailStart(paths))[0] ?? null;
  }

  private async refreshLocal(): Promise<void> {
    await this.local.refresh();
    this.lastLocalAt = Date.now();
  }

  private async tick(manual = false): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      if (now - this.lastLocalAt >= LOCAL_ESTIMATE_MS) await this.refreshLocal();

      const due = manual || now - this.lastPushAt >= this.pushMs;
      if (!due || now - this.lastPushAt < MIN_GAP_MS) return;

      // Detect once per cycle and share it. WHICH provider Claude Code is
      // currently routed to decides who the local JSONL estimate belongs to —
      // see `localOwner` below.
      const provider = await detectProvider();
      const claudeIsOfficial = !provider || provider.official;
      this.deps.log(
        `provider: ${provider ? `${provider.gateway_host ?? "anthropic"} (${provider.source})` : "none"} official=${claudeIsOfficial} monitor=${!!provider?.monitorUrl} key=${!!provider?.authToken}`,
      );

      const streams: UsageStream[] = [];
      const claude = await this.collectClaude(claudeIsOfficial);
      if (claude) streams.push(claude);
      const glm = await this.collectGlm(provider);
      if (glm) streams.push(glm);
      const codex = await this.collectCodex();
      if (codex) streams.push(codex);
      this.deps.log(`collected: claude=${!!claude} glm=${!!glm} codex=${!!codex}`);

      if (streams.length === 0) {
        this.deps.log("no usage streams this cycle — nothing to push");
        // A source may have armed a cooldown even when no fallback stream was
        // available. Persist it so restarting cannot bypass the quiet period.
        await this.deps.store.save();
        return;
      }
      const pushed = await this.push(streams);
      // Only advance the cadence on a real attempt. A token-less skip (e.g. the
      // page still loading at boot) must leave lastPushAt alone, or the post-load
      // retry gets gated out by MIN_GAP_MS and usage never lands.
      if (pushed) {
        this.lastPushAt = Date.now();
        await this.deps.store.save();
      }
    } catch (e) {
      this.deps.log(`tick failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Claude stream. Prefers a fresh authoritative reading; falls back to the
   * calibrated local estimate whenever the API is unavailable — including while
   * a 429 cooldown is in force, which is exactly when the offline path earns its
   * keep.
   */
  private async collectClaude(claudeIsOfficial: boolean): Promise<UsageStream | null> {
    const st = this.deps.store.source("pro");
    const now = Date.now();

    const asStream = (
      snap: Snapshot,
      label: string,
      state: UsageStream["state"] = "live",
      statusMessage?: string,
      observedAt = Date.now(),
    ): UsageStream => ({
      source: "claude_pro",
      label,
      five_hour: snap.five_hour,
      seven_day: snap.seven_day,
      limits: snap.limits,
      provider: null,
      cached: state !== "live",
      observed_at: new Date(observedAt).toISOString(),
      state,
      status_message: statusMessage ?? null,
    });

    const lastKnownStream = (
      state: UsageStream["state"],
      message: string,
    ): UsageStream | null =>
      this.lastApiSnapshot
        ? asStream(this.lastApiSnapshot, "Claude Pro", state, message, this.lastApiAt)
        : null;

    /**
     * The local estimate is only a proxy for CLAUDE PRO usage when Claude Code
     * is actually running against Anthropic. If cc-switch has re-routed it to a
     * gateway, `~/.claude/projects/*.jsonl` records that gateway's traffic — so
     * projecting it as Claude Pro usage would attribute another provider's
     * tokens to the subscription. In that case we report nothing here and let
     * the estimate back the gateway stream instead (see `collectGlm`).
     */
    const estimateStream = (reason: string): UsageStream | null => {
      if (!claudeIsOfficial) return null;
      const est = this.local.estimate();
      if (!est.five_hour && !est.seven_day) return null;
      this.deps.onStatus({ kind: "estimate", at: Date.now(), reason });
      return asStream(est, "Claude Pro (estimate)", "cached", reason);
    };

    // A dedicated profile whose login is dead (renewal exhausted the streak)
    // must NOT keep spending usage-endpoint calls on a token that cannot be
    // refreshed — that volume is the account-keyed 429 risk. Poll the cheap
    // local credentials file so a fresh sign-in is detected promptly, but skip
    // the network call entirely until then.
    const deadPath = this.renewal.terminalPath();
    if (deadPath && !(await this.renewal.externalReloginDetected(deadPath))) {
      this.deps.onStatus({ kind: "error", reason: "Claude Pro sign-in needs renewing." });
      return (
        lastKnownStream(
          "auth_stale",
          "Automatic renewal can't restore this sign-in. Renew your Claude Pro sign-in to resume live tracking.",
        ) ?? estimateStream("sign-in stale; showing local estimate")
      );
    }

    if (now < st.nextAt) {
      const mins = Math.max(1, Math.ceil((st.nextAt - now) / 60_000));
      this.deps.log(`[Claude] cooling down ${mins}m (${st.message || "rate limit"})`);
      return (
        lastKnownStream(
          st.message?.includes("sign-in") ? "auth_stale" : "rate_limited",
          st.message || "Waiting for the provider cooldown before checking again.",
        ) ?? estimateStream(st.message || "cooling down after a rate limit")
      );
    }
    // A cached authoritative reading is still the better answer.
    if (this.lastApiSnapshot && now - this.lastApiAt < API_CACHE_MS) {
      return asStream(this.lastApiSnapshot, "Claude Pro", "live", undefined, this.lastApiAt);
    }

    try {
      const { snapshot, sourceLabel } = await fetchProSnapshot(
        () => {
          const n = this.deps.store.noteUsageCall();
          this.deps.log(`usage call #${n} today`);
          return n;
        },
        this.renewal,
        this.deps.tracker,
      );
      this.deps.store.setCliRenewalState(this.renewal.exportState());
      this.lastApiSnapshot = snapshot;
      this.lastApiAt = Date.now();
      st.streak = 0;
      st.nextAt = 0;
      st.message = undefined;
      if (sourceLabel !== this.activeSourceLabel) {
        this.activeSourceLabel = sourceLabel;
        this.deps.log(`[Claude] now using: ${sourceLabel}`);
      }
      // Learn the denominator ONLY when the local logs actually describe this
      // stream — i.e. when Claude Code is running against Anthropic. Calibrating
      // Claude percentages against gateway traffic would poison the ratio.
      if (claudeIsOfficial) {
        this.local.calibrateFrom(snapshot);
        this.deps.store.setCalibration(this.local.getCalibration());
      }
      this.deps.onStatus({ kind: "ok", at: Date.now(), sourceLabel });
      const stream = asStream(snapshot, "Claude Pro", "live", undefined, this.lastApiAt);
      this.deps.store.setSnapshot(stream.source, stream, this.lastApiAt);
      return stream;
    } catch (e) {
      const err = e as { code?: number | string; message: string; retryMs?: number };
      this.deps.store.setCliRenewalState(this.renewal.exportState());

      if (err.code === 429) {
        st.streak += 1;
        const hold = proUsage429Hold(st.streak, err.retryMs, jitter(30_000));
        st.nextAt = Date.now() + hold;
        st.message = "cooling down after a rate limit";
        this.deps.log(
          `[Claude] rate-limited after ${this.deps.store.usageCallCount()} calls today; quiet for ${Math.round(hold / 60_000)}m`,
        );
        this.deps.onStatus({ kind: "paused", until: st.nextAt, reason: err.message });
        return (
          lastKnownStream("rate_limited", "Provider rate limit; showing the last exact reading.") ??
          estimateStream("rate-limited; showing local estimate")
        );
      }

      if (e instanceof NoCredentialsError) {
        this.deps.onStatus({ kind: "error", reason: "No Claude sign-in found on this machine." });
        return (
          lastKnownStream("auth_stale", "Claude sign-in is unavailable; showing the last reading.") ??
          estimateStream("no Claude sign-in found")
        );
      }

      if (e instanceof AllRejectedError) {
        st.nextAt = Date.now() + 10 * 60_000;
        st.message = "sign-in needs refreshing";
        this.deps.onStatus({ kind: "error", reason: e.message });
        return (
          lastKnownStream(
            "auth_stale",
            "Automatic renewal could not restore this sign-in; showing the last exact reading.",
          ) ?? estimateStream("sign-in stale; showing local estimate")
        );
      }

      this.deps.log(`[Claude] ${err.message}`);
      return (
        lastKnownStream("offline", "Claude is temporarily unreachable; showing the last reading.") ??
        estimateStream("Claude unreachable; showing local estimate")
      );
    }
  }

  /**
   * Gateway stream (GLM / z.ai) — fully independent of Claude's state, so a
   * throttled Claude can never stall it.
   *
   * When Claude Code is routed here, this is also the stream the local JSONL
   * estimate describes, so it is calibrated from (and falls back to) this
   * reading rather than the Claude one.
   */
  private async collectGlm(provider: DetectedProvider | null): Promise<UsageStream | null> {
    const st = this.deps.store.source("glm");
    const stored = this.deps.store.snapshot("glm");
    const lastKnown = (state: UsageStream["state"], message: string): UsageStream | null =>
      stored
        ? {
            ...stored.stream,
            cached: true,
            observed_at: new Date(stored.observedAt).toISOString(),
            state,
            status_message: message,
          }
        : null;

    if (!provider || provider.official || !provider.monitorUrl || !provider.authToken) {
      return lastKnown("offline", "GLM routing is not currently detected; showing the last reading.");
    }

    const label = provider.source === "zai" ? "GLM Coding" : provider.name || "Gateway";

    const asStream = (
      snap: Snapshot,
      suffix = "",
      state: UsageStream["state"] = "live",
      statusMessage?: string,
    ): UsageStream => ({
      source: "glm",
      label: label + suffix,
      five_hour: snap.five_hour,
      seven_day: snap.seven_day,
      limits: snap.limits,
      provider: safeProvider(provider),
      cached: state !== "live",
      observed_at: new Date().toISOString(),
      state,
      status_message: statusMessage ?? null,
    });

    if (Date.now() < st.nextAt) {
      // Cooling down: fall back to the calibrated local estimate, which for a
      // routed Claude Code is exactly this provider's traffic.
      const exact = lastKnown("rate_limited", "Provider cooldown; showing the last exact reading.");
      if (exact) return exact;
      const est = this.local.estimate();
      return est.five_hour || est.seven_day
        ? asStream(est, " (estimate)", "cached", "Provider cooldown; showing an estimate.")
        : null;
    }

    try {
      const snap = await fetchGlmUsage(provider);
      st.streak = 0;
      st.nextAt = 0;
      st.backoff = undefined;
      this.local.calibrateFrom(snap);
      this.deps.store.setCalibration(this.local.getCalibration());
      const stream = asStream(snap);
      this.deps.store.setSnapshot(stream.source, stream);
      return stream;
    } catch (e) {
      const err = e as { code?: number | string; retryMs?: number; message: string };
      if (err.code === 429) {
        const hold = err.retryMs
          ? glmRetryHold(err.retryMs, jitter(4_000))
          : glmBackoffHold(st.backoff, this.pushMs);
        st.backoff = hold;
        st.nextAt = Date.now() + hold;
        this.deps.log(`[${label}] rate-limited; backing off ${Math.round(hold / 1000)}s`);
      } else {
        this.deps.log(`[${label}] ${err.message}`);
      }
      const exact = lastKnown(
        err.code === 429 ? "rate_limited" : "offline",
        err.code === 429
          ? "Provider rate limit; showing the last exact reading."
          : "GLM is temporarily unreachable; showing the last reading.",
      );
      if (exact) return exact;
      const est = this.local.estimate();
      return est.five_hour || est.seven_day
        ? asStream(est, " (estimate)", "cached", "Showing a local estimate.")
        : null;
    }
  }

  private snapshotOf(stream: UsageStream): Snapshot {
    return {
      five_hour: stream.five_hour ?? null,
      seven_day: stream.seven_day ?? null,
      limits: stream.limits ?? null,
    };
  }

  /**
   * OpenAI Codex subscription stream. This is intentionally read-only: Codex
   * CLI owns OAuth refresh and this collector re-reads its auth material every
   * query, matching cc-switch's reliable long-running behavior.
   */
  private async collectCodex(): Promise<UsageStream | null> {
    const state = this.deps.store.source("codex");
    const now = Date.now();
    const streamFromLast = (
      streamState: UsageStream["state"],
      message?: string,
    ): UsageStream | null => {
      if (!this.lastCodexSnapshot) return null;
      return {
        source: "codex",
        label: "Codex",
        five_hour: this.lastCodexSnapshot.five_hour,
        seven_day: this.lastCodexSnapshot.seven_day,
        limits: this.lastCodexSnapshot.limits,
        provider: { name: "OpenAI", gateway_host: "chatgpt.com", official: true },
        cached: streamState !== "live",
        observed_at: new Date(this.lastCodexAt).toISOString(),
        state: streamState,
        status_message: message ?? null,
      };
    };

    if (now < state.nextAt) {
      const fingerprint = await currentCodexCredentialFingerprint();
      if (
        fingerprint &&
        state.credentialFingerprint &&
        fingerprint !== state.credentialFingerprint
      ) {
        state.nextAt = 0;
        state.streak = 0;
        state.message = undefined;
        this.deps.log("[Codex] fresh sign-in detected; resuming quota checks");
      } else {
        const mins = Math.max(1, Math.ceil((state.nextAt - now) / 60_000));
        this.deps.log(`[Codex] cooling down ${mins}m (${state.message || "rate limit"})`);
        return streamFromLast(
          state.message?.includes("sign-in") ? "auth_stale" : "rate_limited",
          state.message || "Waiting for the provider cooldown before checking again.",
        );
      }
    }

    if (this.lastCodexSnapshot && now - this.lastCodexAt < API_CACHE_MS) {
      return streamFromLast("live");
    }

    try {
      const result = await fetchCodexSnapshot();
      this.lastCodexSnapshot = result.snapshot;
      this.lastCodexAt = Date.now();
      state.nextAt = 0;
      state.streak = 0;
      state.message = undefined;
      state.credentialFingerprint = result.fingerprint;
      this.deps.log(`[Codex] quota ok via ${result.sourceLabel}`);
      const stream: UsageStream = {
        source: "codex",
        label: "Codex",
        five_hour: result.snapshot.five_hour,
        seven_day: result.snapshot.seven_day,
        limits: result.snapshot.limits,
        provider: { name: "OpenAI", gateway_host: "chatgpt.com", official: true },
        cached: false,
        observed_at: new Date(this.lastCodexAt).toISOString(),
        state: "live",
        status_message: null,
      };
      this.deps.store.setSnapshot(stream.source, stream, this.lastCodexAt);
      return stream;
    } catch (error) {
      const err = error as { code?: number | string; retryMs?: number; message: string };
      state.credentialFingerprint =
        (await currentCodexCredentialFingerprint()) ?? state.credentialFingerprint;

      if (err.code === 429) {
        state.streak += 1;
        const hold = codexUsage429Hold(state.streak, err.retryMs, jitter(30_000));
        state.nextAt = Date.now() + hold;
        state.message = "cooling down after a rate limit";
        this.deps.log(`[Codex] rate-limited; quiet for ${Math.round(hold / 60_000)}m`);
        return streamFromLast("rate_limited", "Provider rate limit; showing the last exact reading.");
      }
      if (error instanceof AllCodexCredentialsRejectedError) {
        state.nextAt = Date.now() + 10 * 60_000;
        state.message = "Codex sign-in needs refreshing";
        return streamFromLast("auth_stale", "Codex sign-in is stale; showing the last reading.");
      } else if (!(error instanceof NoCodexCredentialsError)) {
        this.deps.log(`[Codex] ${err.message}`);
      }
      return streamFromLast(
        error instanceof NoCodexCredentialsError ? "auth_stale" : "offline",
        error instanceof NoCodexCredentialsError
          ? "Codex sign-in is unavailable; showing the last reading."
          : "Codex is temporarily unreachable; showing the last reading.",
      );
    }
  }

  /**
   * One POST carrying every stream, in the exact shape the existing sharer
   * sends. The server cannot distinguish this app from the downloadable script —
   * that is deliberate, and it is why no web-app change was needed.
   *
   * Returns true if a POST was actually attempted (a token was available), false
   * if it was skipped. The caller only advances the cadence clock on a real
   * attempt — a token-less skip (page still loading at boot, or signed out) must
   * NOT count as a push, otherwise the post-load retry is gated out by MIN_GAP_MS
   * and usage never lands.
   */
  private async push(streams: UsageStream[]): Promise<boolean> {
    const token = await this.deps.getToken();
    if (!token) {
      this.deps.log("push skipped: no bridge token (not signed in yet)");
      this.deps.onStatus({ kind: "error", reason: "Sign in to DuitSini to share usage." });
      return false;
    }

    const primary = streams.find((s) => s.source === "claude_pro" || s.source === "claude") ?? streams[0]!;
    const body = {
      five_hour: primary.five_hour,
      seven_day: primary.seven_day,
      limits: primary.limits,
      provider: primary.provider,
      streams,
      push_seconds: Math.round(this.pushMs / 1000),
      sharer_version: CLIENT_VERSION,
    };

    const r = await safeFetch(this.deps.ingestUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      this.deps.log(`push failed (${r.status}) ${detail.slice(0, 160)}`);
    } else {
      this.deps.log(`push ok (${streams.length} stream${streams.length === 1 ? "" : "s"}: ${streams.map((s) => s.source).join(",")})`);
    }
    return true;
  }
}
