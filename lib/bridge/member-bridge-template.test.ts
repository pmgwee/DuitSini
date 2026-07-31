import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemberBridge } from "./member-bridge-template";

const bridge = () =>
  buildMemberBridge({
    ingestUrl: "https://example.test/api/claude-usage/ingest",
    pullUrl: "https://example.test/api/claude-usage/pull",
    token: "cub_1234567890abcdef",
    accountEmail: "member@example.test",
  });

describe("member usage sharer v8", () => {
  it("auto-discovers Codex CLI auth and uses the cc-switch quota contract", () => {
    const source = bridge();

    expect(source).toContain('const SHARER_VERSION = "8"');
    expect(source).toContain("https://chatgpt.com/backend-api/wham/usage");
    expect(source).toContain('process.env.CODEX_HOME');
    expect(source).toContain('join(homedir(), ".codex", "auth.json")');
    expect(source).toContain('"ChatGPT-Account-Id"');
    expect(source).toContain('"User-Agent": "codex-cli"');
    expect(source).toContain('source: "codex"');
    expect(source).toContain('label: "Codex"');
  });

  it("keeps one shared cadence and replaces every personalized placeholder", () => {
    const source = bridge();

    expect(source).toContain("let PUSH_MS = 300000");
    expect(source).toContain("120-3600");
    expect(source).not.toMatch(/__[A-Z_]+__/);
    expect(source).toContain("member@example.test");
    expect(source).toContain("cub_1234567890abcdef");
  });

  it("generates a syntactically valid self-contained module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "duitsini-sharer-"));
    const file = join(directory, "agent-usage-sharer.mjs");
    try {
      await writeFile(file, bridge(), "utf8");
      expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
