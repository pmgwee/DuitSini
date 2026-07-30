import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Calibration } from "./collectors/claude-local";
import type { RefreshState } from "./collectors/claude-refresh";

/**
 * Small JSON store beside the app's userData.
 *
 * Persisting cooldowns is a v3 lesson carried over verbatim: if a restart forgot
 * an in-progress backoff, quitting and relaunching the app would fire a fresh
 * request straight into a window that is already throttling us. A cooldown must
 * outlive the process that set it.
 */

export interface SourceState {
  /** Epoch ms before which this source must not be contacted. */
  nextAt: number;
  /** Consecutive 429 count — indexes the quiet ladder. */
  streak: number;
  /** Last exponential backoff applied (GLM path). */
  backoff?: number;
  /** Human-readable reason, surfaced in the tray/UI. */
  message?: string;
}

export interface PersistedState {
  sources: Record<string, SourceState>;
  calibration?: Calibration;
  /** Usage-endpoint call count, reset at local midnight. */
  usageCalls?: { day: string; count: number };
  /**
   * Per-credentials-path refresh holds. Persisted for the same reason the
   * sharer persists them: a restart that forgot an in-flight refresh cooldown
   * would fire a fresh POST straight into a window that is already throttling —
   * which is how a login gets flagged in the first place.
   */
  refresh?: Record<string, RefreshState>;
}

const EMPTY: PersistedState = { sources: {} };

export class Store {
  private data: PersistedState = structuredClone(EMPTY);

  constructor(private readonly file: string) {}

  static pathFor(userDataDir: string): string {
    return join(userDataDir, "desktop-state.json");
  }

  async load(): Promise<PersistedState> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as PersistedState;
      this.data = { ...structuredClone(EMPTY), ...raw, sources: raw.sources ?? {} };
    } catch {
      this.data = structuredClone(EMPTY);
    }
    return this.data;
  }

  get(): PersistedState {
    return this.data;
  }

  source(key: string): SourceState {
    const existing = this.data.sources[key];
    if (existing) return existing;
    const fresh: SourceState = { nextAt: 0, streak: 0 };
    this.data.sources[key] = fresh;
    return fresh;
  }

  setCalibration(c: Calibration): void {
    this.data.calibration = c;
  }

  setRefreshState(s: Record<string, RefreshState>): void {
    this.data.refresh = s;
  }

  /**
   * Count a usage-endpoint call. Mirrors the sharer's `.sharer-usage-count.json`
   * so the volume that trips a 429 stays observable — under this app's
   * no-refresh policy this should be the ONLY family of calls we make.
   */
  noteUsageCall(): number {
    const day = new Date().toISOString().slice(0, 10);
    const cur = this.data.usageCalls;
    if (!cur || cur.day !== day) {
      this.data.usageCalls = { day, count: 1 };
      return 1;
    }
    cur.count += 1;
    return cur.count;
  }

  usageCallCount(): number {
    const day = new Date().toISOString().slice(0, 10);
    const cur = this.data.usageCalls;
    return cur && cur.day === day ? cur.count : 0;
  }

  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch {
      // A failed state write must never take the app down; worst case we lose a
      // cooldown across restart, which the ladders re-derive.
    }
  }
}
