/**
 * Forensic usage journal — the thing the v6/v7 docs are NOT.
 *
 * The rate-limit and ~8h-token-expiry stories in the docs are inferred from
 * field observations after the fact, not a proven root cause. This append-only
 * journal captures the raw evidence AT every decisive hop — the token's real
 * `expiresAt` at the moment of each call, the daily call count when a 429 fired,
 * the `retry-after`/reset headers, the active credential source, and every
 * refresh decision + outcome — so the NEXT time usage tracking stops, the file
 * tells us what actually happened instead of a theory. Open it from the tray
 * ("Open usage log") or read `userData/usage-tracker.jsonl`.
 *
 * One JSON object per line; events are serialized so a burst (a credential
 * walk) never interleaves; the file is rotated to the last KEEP_LINES entries
 * once it exceeds MAX_BYTES.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface UsageTracker {
  readonly file: string;
  /** Append a structured event. Fire-and-forget; never throws. */
  event(type: string, data: Record<string, unknown>): void;
}

const MAX_BYTES = 2_000_000;
const KEEP_LINES = 1500;

/** Event types that also mirror to the live console — the decisive failures. */
const LOUD = new Set([
  "usage_401",
  "usage_403",
  "usage_429",
  "usage_error",
  "refresh_429",
  "refresh_reauth",
  "refresh_5xx",
]);

export function createUsageTracker(file: string, log?: (line: string) => void): UsageTracker {
  const dir = dirname(file);
  void mkdir(dir, { recursive: true }).catch(() => {});

  // Serialize appends: a credential walk emits several events back-to-back, and
  // concurrent appendFile calls on Windows can interleave or race.
  let queue: Promise<void> = Promise.resolve();
  const append = (line: string): void => {
    queue = queue.then(() => appendFile(file, line + "\n", "utf8")).catch(() => {});
  };

  let checksSinceRotate = 0;
  const maybeRotate = (): void => {
    if (++checksSinceRotate < 40) return;
    checksSinceRotate = 0;
    void (async () => {
      try {
        if ((await stat(file)).size <= MAX_BYTES) return;
        const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
        if (lines.length > KEEP_LINES) {
          await writeFile(file, lines.slice(-KEEP_LINES).join("\n") + "\n", "utf8");
        }
      } catch {
        /* best-effort rotation */
      }
    })();
  };

  return {
    file,
    event(type, data) {
      append(JSON.stringify({ ts: Date.now(), type, ...data }));
      if (log && LOUD.has(type)) log(`[tracker] ${type} ${JSON.stringify(data)}`);
      maybeRotate();
    },
  };
}
