import {
  glmBackoffHold,
  glmRetryHold,
  proUsage429Hold,
} from "../../lib/bridge/sharer/backoff";
import {
  API_CACHE_MS,
  CLIENT_VERSION,
  DEFAULT_PUSH_MS,
  LOCAL_ESTIMATE_MS,
  MIN_GAP_MS,
  clampPushMs,
} from "./config";
import { AllRejectedError, NoCredentialsError, fetchProSnapshot } from "./collectors/claude-oauth";
import { RefreshManager } from "./collectors/claude-refresh";
import { LocalUsageEstimator } from "./collectors/claude-local";
import {
  detectProvider,
  fetchGlmUsage,
  safeProvider,
  type DetectedProvider,
} from "./collectors/glm";
import type { Store } from "./store";
import { safeFetch } from "./net";
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
 * What is NOT here, deliberately: any token refresh. See `claude-oauth.ts`.
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
}

const jitter = (n: number) => Math.floor(Math.random() * n);

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly local = new LocalUsageEstimator();
  private readonly refresher: RefreshManager;
  private pushMs = DEFAULT_PUSH_MS;
  private lastPushAt = 0;
  private lastApiAt = 0;
  private lastApiSnapshot: Snapshot | null = null;
  private lastLocalAt = 0;
  private activeSourceLabel: string | null = null;
  private running = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.refresher = new RefreshManager(deps.log);
  }

  async start(pushSeconds?: number): Promise<void> {
    if (pushSeconds) this.pushMs = clampPushMs(pushSeconds * 1000);
    this.local.loadCalibration(this.deps.store.get().calibration);
    this.refresher.importState(this.deps.store.get().refresh);
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
      this.deps.log(`collected: claude=${!!claude} glm=${!!glm}`);

      if (streams.length === 0) {
        this.deps.log("no usage streams this cycle — nothing to push");
        return;
      }
      await this.push(streams);
      this.lastPushAt = Date.now();
      await this.deps.store.save();
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

    const asStream = (snap: Snapshot, label: string): UsageStream => ({
      source: "claude_pro",
      label,
      five_hour: snap.five_hour,
      seven_day: snap.seven_day,
      limits: snap.limits,
      provider: null,
    });

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
      return asStream(est, "Claude Pro (estimate)");
    };

    if (now < st.nextAt) {
      const mins = Math.max(1, Math.ceil((st.nextAt - now) / 60_000));
      this.deps.log(`[Claude] cooling down ${mins}m (${st.message || "rate limit"})`);
      return estimateStream(st.message || "cooling down after a rate limit");
    }
    // A cached authoritative reading is still the better answer.
    if (this.lastApiSnapshot && now - this.lastApiAt < API_CACHE_MS) {
      return asStream(this.lastApiSnapshot, "Claude Pro");
    }

    try {
      const { snapshot, sourceLabel } = await fetchProSnapshot(() => {
        const n = this.deps.store.noteUsageCall();
        this.deps.log(`usage call #${n} today`);
      }, this.refresher);
      this.deps.store.setRefreshState(this.refresher.exportState());
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
      return asStream(snapshot, "Claude Pro");
    } catch (e) {
      const err = e as { code?: number | string; message: string; retryMs?: number };
      // Persist any refresh hold the walk just armed, so a restart honours it.
      this.deps.store.setRefreshState(this.refresher.exportState());

      if (err.code === 429) {
        st.streak += 1;
        const hold = proUsage429Hold(st.streak, err.retryMs, jitter(30_000));
        st.nextAt = Date.now() + hold;
        st.message = "cooling down after a rate limit";
        this.deps.log(
          `[Claude] rate-limited after ${this.deps.store.usageCallCount()} calls today; quiet for ${Math.round(hold / 60_000)}m`,
        );
        this.deps.onStatus({ kind: "paused", until: st.nextAt, reason: err.message });
        return estimateStream("rate-limited — showing local estimate");
      }

      if (e instanceof NoCredentialsError) {
        this.deps.onStatus({ kind: "error", reason: "No Claude sign-in found on this machine." });
        return estimateStream("no Claude sign-in found");
      }

      if (e instanceof AllRejectedError) {
        // Under no-refresh this is the expected end state when the member does
        // not actually use Claude Code on their Claude account. Retry gently and
        // lean on the estimate meanwhile.
        st.nextAt = Date.now() + 10 * 60_000;
        st.message = "sign-in needs refreshing";
        this.deps.onStatus({ kind: "error", reason: e.message });
        return estimateStream("sign-in stale — showing local estimate");
      }

      this.deps.log(`[Claude] ${err.message}`);
      return estimateStream("Claude unreachable — showing local estimate");
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
    if (!provider || provider.official || !provider.monitorUrl || !provider.authToken) return null;

    const label = provider.source === "zai" ? "GLM Coding" : provider.name || "Gateway";

    const asStream = (snap: Snapshot, suffix = ""): UsageStream => ({
      source: "glm",
      label: label + suffix,
      five_hour: snap.five_hour,
      seven_day: snap.seven_day,
      limits: snap.limits,
      provider: safeProvider(provider),
    });

    if (Date.now() < st.nextAt) {
      // Cooling down: fall back to the calibrated local estimate, which for a
      // routed Claude Code is exactly this provider's traffic.
      const est = this.local.estimate();
      return est.five_hour || est.seven_day ? asStream(est, " (estimate)") : null;
    }

    try {
      const snap = await fetchGlmUsage(provider);
      st.streak = 0;
      st.nextAt = 0;
      st.backoff = undefined;
      this.local.calibrateFrom(snap);
      this.deps.store.setCalibration(this.local.getCalibration());
      return asStream(snap);
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
      const est = this.local.estimate();
      return est.five_hour || est.seven_day ? asStream(est, " (estimate)") : null;
    }
  }

  /**
   * One POST carrying every stream, in the exact shape the existing sharer
   * sends. The server cannot distinguish this app from the downloadable script —
   * that is deliberate, and it is why no web-app change was needed.
   */
  private async push(streams: UsageStream[]): Promise<void> {
    const token = await this.deps.getToken();
    if (!token) {
      this.deps.log("push skipped: no bridge token (not signed in yet)");
      this.deps.onStatus({ kind: "error", reason: "Sign in to DuitSini to share usage." });
      return;
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
  }
}
