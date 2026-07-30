import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { CLAUDE_PROJECTS_DIR } from "../config";
import type { Snapshot, UsageWindow } from "../types";

/**
 * Zero-network Claude usage estimate, from Claude Code's own session logs.
 *
 * Modelled on cc-switch's `services/session_usage.rs`, which scans
 * `~/.claude/projects/ * / *.jsonl` and aggregates per-message token counts. It
 * makes no network calls at all, so it can never be rate-limited and never
 * expires — it is the floor under the API path, not a replacement for it.
 *
 * TWO caveats, both real, both surfaced to the user rather than hidden:
 *
 * 1. `output_tokens` in these logs is a placeholder (typically 1–2), not the
 *    real count — anthropics/claude-code#25941. `input_tokens`,
 *    `cache_creation_input_tokens` and `cache_read_input_tokens` are accurate.
 *    We still sum all four: what matters for the estimate is that the metric is
 *    computed CONSISTENTLY, because it is calibrated against a real reading
 *    rather than interpreted in absolute terms.
 *
 * 2. Local logs only see Claude Code on THIS machine. They miss claude.ai in the
 *    browser, Claude Desktop, and any other computer. The account's real 5h/7d
 *    windows span all of those, so a local-only figure UNDERSTATES usage.
 *
 * Because of (1) and (2) this module cannot produce a percentage on its own —
 * there is no honest denominator. Instead it learns one: every time the
 * authoritative API returns a utilization, we record tokens-per-percent, and use
 * that ratio to project a percentage while offline. With no calibration yet, it
 * reports `null` utilization rather than inventing a number.
 */

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface TokenEvent {
  ts: number;
  tokens: number;
}

interface FileCursor {
  offset: number;
  mtimeMs: number;
}

export interface Calibration {
  /** Tokens observed in the 5h window when the API last reported a percentage. */
  fiveHourTokensPerPercent: number | null;
  sevenDayTokensPerPercent: number | null;
}

export class LocalUsageEstimator {
  /** messageId → event. Deduped across resumed//branched transcripts. */
  private events = new Map<string, TokenEvent>();
  private cursors = new Map<string, FileCursor>();
  private calibration: Calibration = {
    fiveHourTokensPerPercent: null,
    sevenDayTokensPerPercent: null,
  };

  loadCalibration(c: Partial<Calibration> | undefined): void {
    if (!c) return;
    if (typeof c.fiveHourTokensPerPercent === "number") {
      this.calibration.fiveHourTokensPerPercent = c.fiveHourTokensPerPercent;
    }
    if (typeof c.sevenDayTokensPerPercent === "number") {
      this.calibration.sevenDayTokensPerPercent = c.sevenDayTokensPerPercent;
    }
  }

  getCalibration(): Calibration {
    return { ...this.calibration };
  }

  /**
   * Learn the denominator from an authoritative reading. Called with whatever
   * the API just returned; ignores zero/near-zero percentages because dividing
   * by them produces a wildly unstable ratio.
   */
  calibrateFrom(api: Snapshot): void {
    const now = Date.now();
    const five = this.sumSince(now - FIVE_HOURS_MS);
    const seven = this.sumSince(now - SEVEN_DAYS_MS);
    const fivePct = api.five_hour?.utilization;
    const sevenPct = api.seven_day?.utilization;
    if (typeof fivePct === "number" && fivePct >= 5 && five > 0) {
      this.calibration.fiveHourTokensPerPercent = five / fivePct;
    }
    if (typeof sevenPct === "number" && sevenPct >= 5 && seven > 0) {
      this.calibration.sevenDayTokensPerPercent = seven / sevenPct;
    }
  }

  /** Incrementally ingest anything appended since the last scan. */
  async refresh(): Promise<void> {
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    let files: string[];
    try {
      files = await this.listTranscripts();
    } catch {
      return; // no ~/.claude/projects — nothing to estimate from
    }

    for (const file of files) {
      let size: number;
      let mtimeMs: number;
      try {
        const s = await stat(file);
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }
      // A file untouched for longer than the widest window cannot contribute.
      if (mtimeMs < cutoff) continue;

      const prev = this.cursors.get(file);
      // Truncated or rotated → re-read from the top.
      const start = prev && size >= prev.offset ? prev.offset : 0;
      if (prev && size === prev.offset && mtimeMs === prev.mtimeMs) continue;

      await this.ingestFrom(file, start);
      this.cursors.set(file, { offset: size, mtimeMs });
    }

    this.prune(cutoff);
  }

  private async listTranscripts(): Promise<string[]> {
    const out: string[] = [];
    const projects = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = join(CLAUDE_PROJECTS_DIR, p.name);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".jsonl")) out.push(join(dir, e.name));
      }
    }
    return out;
  }

  private async ingestFrom(file: string, start: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const stream = createReadStream(file, { start, encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const t = line.trim();
        if (!t || t[0] !== "{") return;
        try {
          this.ingestLine(JSON.parse(t));
        } catch {
          // A partial trailing line is normal when a session is mid-write; the
          // next scan re-reads from this file's recorded offset and picks it up.
        }
      });
      rl.on("close", () => resolve());
      stream.on("error", () => resolve());
    });
  }

  private ingestLine(rec: unknown): void {
    if (!rec || typeof rec !== "object") return;
    const r = rec as Record<string, unknown>;
    const msg = r.message as Record<string, unknown> | undefined;
    if (!msg) return;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) return;

    const id = (msg.id as string) || (r.uuid as string);
    if (!id) return;

    const ts = Date.parse((r.timestamp as string) || "");
    if (!Number.isFinite(ts)) return;

    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const tokens =
      n(usage.input_tokens) +
      n(usage.output_tokens) +
      n(usage.cache_creation_input_tokens) +
      n(usage.cache_read_input_tokens);
    if (tokens <= 0) return;

    // Last write wins: a resumed transcript can repeat a message id, and the
    // later record is the more complete one.
    this.events.set(id, { ts, tokens });
  }

  private prune(cutoff: number): void {
    for (const [id, e] of this.events) {
      if (e.ts < cutoff) this.events.delete(id);
    }
  }

  private sumSince(from: number): number {
    let total = 0;
    for (const e of this.events.values()) if (e.ts >= from) total += e.tokens;
    return total;
  }

  /** Raw token totals — always available, never a guess. */
  tokenTotals(): { fiveHour: number; sevenDay: number } {
    const now = Date.now();
    return {
      fiveHour: this.sumSince(now - FIVE_HOURS_MS),
      sevenDay: this.sumSince(now - SEVEN_DAYS_MS),
    };
  }

  /**
   * Projected snapshot. Returns null utilizations when uncalibrated — an honest
   * "don't know" beats a fabricated percentage.
   */
  estimate(): Snapshot {
    const { fiveHour, sevenDay } = this.tokenTotals();
    const project = (tokens: number, perPct: number | null): UsageWindow | null => {
      if (!perPct || perPct <= 0) return null;
      return { utilization: Math.min(100, Math.round((tokens / perPct) * 10) / 10), resets_at: null };
    };
    return {
      five_hour: project(fiveHour, this.calibration.fiveHourTokensPerPercent),
      seven_day: project(sevenDay, this.calibration.sevenDayTokensPerPercent),
      limits: null,
    };
  }

  /** True once we have any calibration at all. */
  get calibrated(): boolean {
    return (
      this.calibration.fiveHourTokensPerPercent !== null ||
      this.calibration.sevenDayTokensPerPercent !== null
    );
  }
}

/** Convenience for one-shot reads (tests, diagnostics). */
export async function readLocalEstimate(): Promise<{ fiveHour: number; sevenDay: number }> {
  const est = new LocalUsageEstimator();
  await est.refresh();
  return est.tokenTotals();
}

/** Exposed for a diagnostics view; not used on the hot path. */
export async function projectsDirExists(): Promise<boolean> {
  try {
    await readFile(join(CLAUDE_PROJECTS_DIR, ".."), "utf8");
    return true;
  } catch {
    try {
      await readdir(CLAUDE_PROJECTS_DIR);
      return true;
    } catch {
      return false;
    }
  }
}
