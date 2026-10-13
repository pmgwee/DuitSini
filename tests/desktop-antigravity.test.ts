import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_USAGE_ARGS,
  AgyAuthError,
  AgyModelTurnError,
  AgyNotInstalledError,
  buildAdapterScriptSource,
  collectAntigravityStreams,
  fetchAntigravityUsage,
  parseAgyUsageOutput,
  type AgyRunner,
  connectAntigravity,
  defaultAdapterCmdPath,
  defaultAdapterScriptPath,
  defaultAdapterShPath,
  defaultAntigravityQuotaPath,
  disconnectAntigravity,
  getAntigravityStatus,
  installAdapter,
} from "../desktop/src/collectors/antigravity";

describe("desktop antigravity collector and statusline adapter", () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "duitsini-agy-test-"));
    try {
      return await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe("installAdapter", () => {
    it("writes the adapter script with atomic file write logic and correct target quota path", () => {
      withTempDir((userData) => {
        const { scriptPath, commandPath } = installAdapter(userData);
        expect(scriptPath).toBe(defaultAdapterScriptPath(userData));

        const scriptContent = readFileSync(scriptPath, "utf8");
        expect(scriptContent).toContain("antigravity-quota.json");
        expect(scriptContent).toContain("renameSync");
        expect(scriptContent).toContain("process.stderr.write");

        if (process.platform === "win32") {
          expect(commandPath).toBe(defaultAdapterCmdPath(userData));
          const cmdContent = readFileSync(commandPath, "utf8");
          expect(cmdContent).toContain("node");
          expect(cmdContent).toContain("antigravity-statusline.mjs");
        } else {
          expect(commandPath).toBe(defaultAdapterShPath(userData));
          const shContent = readFileSync(commandPath, "utf8");
          expect(shContent).toContain("node");
        }
      });
    });
  });

  describe("connectAntigravity and disconnectAntigravity", () => {
    it("connects cleanly into settings.json with stack_with_default and disconnects reversibly", async () => {
      await withTempDir(async (userData) => {
        const settingsPath = join(userData, "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({ colorScheme: "dark", model: "Gemini 3.8 Flash" }, null, 2),
          "utf8",
        );

        // 1. Initial status: installed, not connected
        const statusBefore = await getAntigravityStatus(userData, settingsPath);
        expect(statusBefore.installed).toBe(true);
        expect(statusBefore.connected).toBe(false);

        // 2. Connect
        const connectResult = await connectAntigravity(userData, settingsPath);
        expect(connectResult.ok).toBe(true);

        const statusConnected = await getAntigravityStatus(userData, settingsPath);
        expect(statusConnected.connected).toBe(true);
        expect(statusConnected.isOurCommand).toBe(true);
        expect(statusConnected.statusLineConfigured).toBe(true);

        // Verify settings.json contents: preserved previous settings + added statusLine
        const savedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(savedSettings.colorScheme).toBe("dark");
        expect(savedSettings.model).toBe("Gemini 3.8 Flash");
        expect(savedSettings.statusLine.type).toBe("command");
        expect(savedSettings.statusLine.stack_with_default).toBe(true);

        // 3. Disconnect
        const disconnectResult = await disconnectAntigravity(userData, settingsPath);
        expect(disconnectResult.ok).toBe(true);

        const statusAfter = await getAntigravityStatus(userData, settingsPath);
        expect(statusAfter.connected).toBe(false);
        expect(statusAfter.statusLineConfigured).toBe(false);

        const disconnectedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(disconnectedSettings.colorScheme).toBe("dark");
        expect(disconnectedSettings.statusLine).toBeUndefined();
      });
    });

    it("detects conflict and refuses to clobber existing custom status line", async () => {
      await withTempDir(async (userData) => {
        const settingsPath = join(userData, "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            statusLine: {
              type: "command",
              command: "custom-my-prompt.sh",
              stack_with_default: false,
            },
          }),
          "utf8",
        );

        const status = await getAntigravityStatus(userData, settingsPath);
        expect(status.connected).toBe(false);
        expect(status.statusLineConfigured).toBe(true);
        expect(status.isOurCommand).toBe(false);
        expect(status.existingCommand).toBe("custom-my-prompt.sh");

        const connectResult = await connectAntigravity(userData, settingsPath);
        expect(connectResult.ok).toBe(false);
        expect(connectResult.conflict).toBe(true);
        expect(connectResult.existingCommand).toBe("custom-my-prompt.sh");

        // The existing custom command must be completely preserved!
        const preservedSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(preservedSettings.statusLine.command).toBe("custom-my-prompt.sh");
      });
    });
  });

  describe("collectAntigravityStreams", () => {
    it("returns empty array when quota file is absent or empty without throwing", async () => {
      await withTempDir(async (userData) => {
        const missingPath = join(userData, "nonexistent.json");
        const streams = await collectAntigravityStreams(missingPath);
        expect(streams).toEqual([]);

        const emptyPath = join(userData, "empty.json");
        writeFileSync(emptyPath, "   \n", "utf8");
        const emptyStreams = await collectAntigravityStreams(emptyPath);
        expect(emptyStreams).toEqual([]);
      });
    });

    it("parses sanitized snapshot and returns live streams when fresh", async () => {
      await withTempDir(async (userData) => {
        const quotaPath = defaultAntigravityQuotaPath(userData);
        const now = 1780000000000;
        const observedAt = new Date(now - 2 * 60 * 1000).toISOString(); // 2 minutes ago

        const snapshot = {
          product: "antigravity",
          version: "1.3.3",
          email: "user@example.com",
          plan_tier: "Pro",
          observed_at: observedAt,
          quota: {
            "gemini-weekly": {
              remaining_fraction: 0.8,
              reset_time: "2026-10-19T16:32:31Z",
            },
            "gemini-5h": {
              remaining_fraction: 0.5,
              reset_time: "2026-10-12T21:32:31Z",
            },
            "3p-weekly": {
              remaining_fraction: 0.9,
              reset_time: "2026-10-19T16:32:31Z",
            },
            "3p-5h": {
              remaining_fraction: 1.0,
              reset_time: "2026-10-12T21:32:31Z",
            },
          },
        };

        writeFileSync(quotaPath, JSON.stringify(snapshot), "utf8");

        const streams = await collectAntigravityStreams(quotaPath, now);
        expect(streams.length).toBe(2);

        const gemini = streams.find((s) => s.source === "google_gemini");
        expect(gemini).toBeDefined();
        expect(gemini?.label).toBe("Google AI Pro · Gemini");
        expect(gemini?.state).toBe("live");
        expect(gemini?.cached).toBe(false);
        // remaining 0.5 -> 50% used
        expect(gemini?.five_hour?.utilization).toBe(50);
        // remaining 0.8 -> 20% used
        expect(gemini?.seven_day?.utilization).toBe(20);

        const claudePartner = streams.find((s) => s.source === "google_claude");
        expect(claudePartner).toBeDefined();
        expect(claudePartner?.label).toBe("Google AI Pro · Claude + GPT-OSS");
        expect(claudePartner?.state).toBe("live");
        // remaining 1.0 -> 0% used
        expect(claudePartner?.five_hour?.utilization).toBe(0);
        // remaining 0.9 -> 10% used
        expect(claudePartner?.seven_day?.utilization).toBe(10);
      });
    });

    it("marks streams as cached (saved reading) when observation is older than 15 minutes", async () => {
      await withTempDir(async (userData) => {
        const quotaPath = defaultAntigravityQuotaPath(userData);
        const now = 1780000000000;
        const observedAt = new Date(now - 30 * 60 * 1000).toISOString(); // 30 minutes ago

        const snapshot = {
          product: "antigravity",
          observed_at: observedAt,
          quota: {
            "gemini-weekly": { remaining_fraction: 0.75 },
            "3p-weekly": { remaining_fraction: 0.5 },
          },
        };

        writeFileSync(quotaPath, JSON.stringify(snapshot), "utf8");

        const streams = await collectAntigravityStreams(quotaPath, now);
        expect(streams.length).toBe(2);

        for (const s of streams) {
          expect(s.state).toBe("cached");
          expect(s.cached).toBe(true);
          expect(s.status_message).toContain("Saved reading");
        }
      });
    });

    it("gracefully tolerates corrupt JSON in quota file without throwing", async () => {
      await withTempDir(async (userData) => {
        const quotaPath = defaultAntigravityQuotaPath(userData);
        writeFileSync(quotaPath, "{ invalid json corrupt content !!!", "utf8");

        const streams = await collectAntigravityStreams(quotaPath);
        expect(streams).toEqual([]);
      });
    });
  });

  describe("agy /usage poller", () => {
    // Real `agy -p "/usage" --output-format json` envelope captured 2026-10-13 (agy 1.3.3).
    const realEnvelope = {
      conversation_id: "",
      status: "SUCCESS",
      response: "Gemini Models\tWeekly Limit Remaining\t96%\t2026-10-19T17:19:49Z\n",
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.9582148790359497, reset_time: "2026-10-19T17:19:49Z" },
                { id: "gemini-5h", window: "5h", remaining_fraction: 0.8010379076004028, reset_time: "2026-10-13T07:52:55Z" },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-20T04:17:17Z" },
                { id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-10-13T09:17:17Z" },
              ],
            },
          ],
        },
      },
    };

    it("parses the real envelope into all four windows as percent used", () => {
      const pools = parseAgyUsageOutput(JSON.stringify(realEnvelope), 1780000000000);
      expect(pools.gemini.weekly?.utilization).toBe(4.2);
      expect(pools.gemini.five_hour?.utilization).toBe(19.9);
      expect(pools.gemini.five_hour?.resets_at).toBe("2026-10-13T07:52:55.000Z");
      expect(pools.claudePartner.weekly?.utilization).toBe(0);
      expect(pools.claudePartner.five_hour?.utilization).toBe(0);
      expect(pools.observedAt).toBe(new Date(1780000000000).toISOString());
    });

    it("refuses output that spent tokens or ran a model turn", () => {
      const spent = { ...realEnvelope, usage: { ...realEnvelope.usage, total_tokens: 42 } };
      expect(() => parseAgyUsageOutput(JSON.stringify(spent))).toThrow(AgyModelTurnError);
      const turn = { ...realEnvelope, num_turns: 1 };
      expect(() => parseAgyUsageOutput(JSON.stringify(turn))).toThrow(AgyModelTurnError);
      const notUsage = { ...realEnvelope, command: undefined };
      expect(() => parseAgyUsageOutput(JSON.stringify(notUsage))).toThrow(AgyModelTurnError);
    });

    it("rejects unreadable or empty output instead of fabricating readings", () => {
      expect(() => parseAgyUsageOutput("not json")).toThrow(/unreadable/);
      const empty = { ...realEnvelope, command: { name: "usage", data: { groups: [] } } };
      expect(() => parseAgyUsageOutput(JSON.stringify(empty))).toThrow(/no recognizable/);
    });

    it("runs only the official /usage command and maps runner failures", async () => {
      const calls: string[][] = [];
      const ok: AgyRunner = async (_bin, args) => {
        calls.push(args);
        return { stdout: JSON.stringify(realEnvelope), stderr: "" };
      };
      const pools = await fetchAntigravityUsage({ binary: "agy", runner: ok, cwd: "." });
      expect(calls).toEqual([[...AGY_USAGE_ARGS]]);
      expect(pools.gemini.weekly).not.toBeNull();

      const missing: AgyRunner = async () => {
        throw Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
      };
      await expect(fetchAntigravityUsage({ binary: "agy", runner: missing, cwd: "." })).rejects.toThrow(AgyNotInstalledError);

      const unauthenticated: AgyRunner = async () => {
        throw Object.assign(new Error("exit 1"), { code: 1, stderr: "Error: authentication required" });
      };
      await expect(fetchAntigravityUsage({ binary: "agy", runner: unauthenticated, cwd: "." })).rejects.toThrow(AgyAuthError);
    });
  });
});
