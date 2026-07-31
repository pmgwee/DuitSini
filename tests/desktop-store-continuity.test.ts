import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../desktop/src/store";
import type { UsageStream } from "../desktop/src/types";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("desktop usage continuity store", () => {
  it("restores the last observed Claude, GLM, and Codex streams across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duitsini-store-"));
    dirs.push(dir);
    const file = join(dir, "desktop-state.json");
    const observedAt = Date.parse("2026-08-01T00:00:00.000Z");
    const streams: UsageStream[] = [
      { source: "claude_pro", label: "Claude Pro", five_hour: null, seven_day: null },
      { source: "glm", label: "GLM Coding", five_hour: null, seven_day: null },
      { source: "codex", label: "Codex", five_hour: null, seven_day: null },
    ];

    const first = new Store(file);
    await first.load();
    for (const stream of streams) first.setSnapshot(stream.source, stream, observedAt);
    first.setCliRenewalState({
      "C:\\Users\\member\\.claude-pro\\.credentials.json": {
        fingerprint: "safe-digest",
        blockedUntil: observedAt + 60_000,
      },
    });
    await first.save();

    const restarted = new Store(file);
    const state = await restarted.load();
    expect(Object.keys(state.snapshots ?? {}).sort()).toEqual(["claude_pro", "codex", "glm"]);
    expect(restarted.snapshot("claude_pro")).toEqual({ stream: streams[0], observedAt });
    expect(state.cliRenewal).toEqual({
      "C:\\Users\\member\\.claude-pro\\.credentials.json": {
        fingerprint: "safe-digest",
        blockedUntil: observedAt + 60_000,
      },
    });

    const serialized = await readFile(file, "utf8");
    expect(serialized).not.toContain("accessToken");
    expect(serialized).not.toContain("refreshToken");
  });
});
