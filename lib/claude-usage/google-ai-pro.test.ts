import { describe, expect, it } from "vitest";
import {
  fractionToPercentUsed,
  remainingPercentToPercentUsed,
  resolveResetTime,
  sanitizeAntigravityStatusLine,
  parseQuotaBuckets,
  parseManualUsageImport,
  buildGoogleUsageStreams,
  GOOGLE_GEMINI_SOURCE,
  GOOGLE_CLAUDE_SOURCE,
  GOOGLE_GEMINI_LABEL,
  GOOGLE_CLAUDE_LABEL,
} from "./google-ai-pro";

describe("Google AI Pro quota calculations", () => {
  describe("percentage direction and boundaries", () => {
    it("converts remaining fraction to percent used: 1.0 remaining is 0% used", () => {
      expect(fractionToPercentUsed(1.0)).toBe(0);
    });

    it("converts 0.0 remaining to 100% used", () => {
      expect(fractionToPercentUsed(0.0)).toBe(100);
    });

    it("converts 0.9528 remaining to 4.7% used (with rounding)", () => {
      expect(fractionToPercentUsed(0.952762)).toBe(4.7);
    });

    it("converts 0.9378 remaining to 6.2% used", () => {
      expect(fractionToPercentUsed(0.9378)).toBe(6.2);
    });

    it("returns null (unavailable) for invalid, out of range, or corrupt values", () => {
      expect(fractionToPercentUsed(null)).toBeNull();
      expect(fractionToPercentUsed(undefined)).toBeNull();
      expect(fractionToPercentUsed(Number.NaN)).toBeNull();
      expect(fractionToPercentUsed(-0.5)).toBeNull();
      expect(fractionToPercentUsed(1.5)).toBeNull();
      expect(fractionToPercentUsed("100%")).toBeNull();
    });

    it("parses remaining percent string: 100% remaining -> 0% used, 95% remaining -> 5% used", () => {
      expect(remainingPercentToPercentUsed("100%")).toBe(0);
      expect(remainingPercentToPercentUsed("98%")).toBe(2);
      expect(remainingPercentToPercentUsed("0%")).toBe(100);
      expect(remainingPercentToPercentUsed("invalid")).toBeNull();
      expect(remainingPercentToPercentUsed(null)).toBeNull();
    });
  });

  describe("reset time derivation", () => {
    const nowMs = 1780000000000;

    it("prefers provider-supplied reset_time ISO string", () => {
      const resetTime = "2026-10-19T16:32:31Z";
      expect(resolveResetTime(resetTime, 500, nowMs)).toBe(new Date(resetTime).toISOString());
    });

    it("derives reset timestamp from reset_in_seconds relative to observation time", () => {
      const derived = resolveResetTime(null, 3600, nowMs);
      expect(derived).toBe(new Date(nowMs + 3600 * 1000).toISOString());
    });

    it("returns null when neither reset_time nor reset_in_seconds is provided", () => {
      expect(resolveResetTime(null, null, nowMs)).toBeNull();
      expect(resolveResetTime("invalid-date", null, nowMs)).toBeNull();
    });
  });

  describe("sanitization", () => {
    it("sanitizes statusline payload by stripping sensitive paths and retaining only quota data", () => {
      const sensitiveInput = {
        product: "antigravity",
        version: "1.3.3",
        plan_tier: "Pro",
        email: "developer@example.com",
        cwd: "/Users/sensitive/work/secret-repo",
        session_id: "sec-12345",
        conversation_id: "conv-67890",
        transcript_path: "/Users/sensitive/.gemini/transcripts/top-secret.jsonl",
        context_window: {
          total_input_tokens: 100000,
          current_usage: { input_tokens: 50000 },
        },
        quota: {
          "gemini-weekly": {
            remaining_fraction: 0.9378,
            reset_time: "2026-10-19T16:32:31Z",
            reset_in_seconds: 560580,
          },
          "gemini-5h": {
            remaining_fraction: 0.98,
            reset_time: "2026-10-12T22:19:49Z",
          },
          "3p-weekly": {
            remaining_fraction: 1.0,
            reset_time: "2026-10-19T17:26:33Z",
          },
          "3p-5h": {
            remaining_fraction: 1.0,
            reset_time: "2026-10-12T22:26:33Z",
          },
        },
      };

      const sanitized = sanitizeAntigravityStatusLine(sensitiveInput, 1780000000000);
      expect(sanitized).not.toBeNull();
      expect(sanitized?.product).toBe("antigravity");
      expect(sanitized?.version).toBe("1.3.3");
      expect(sanitized?.plan_tier).toBe("Pro");
      expect(sanitized?.email).toBe("developer@example.com");

      // Verify sensitive fields are not present
      const raw = sanitized as unknown as Record<string, unknown>;
      expect(raw.cwd).toBeUndefined();
      expect(raw.session_id).toBeUndefined();
      expect(raw.conversation_id).toBeUndefined();
      expect(raw.transcript_path).toBeUndefined();
      expect(raw.context_window).toBeUndefined();

      // Quota is preserved
      expect(sanitized?.quota["gemini-weekly"].remaining_fraction).toBe(0.9378);
      expect(sanitized?.quota["3p-weekly"].remaining_fraction).toBe(1.0);
    });
  });

  describe("all four bucket mappings and unknown bucket tolerance", () => {
    it("extracts all four distinct quota windows correctly", () => {
      const snapshot = {
        product: "antigravity",
        version: "1.3.3",
        email: "developer@example.com",
        plan_tier: "Pro",
        observed_at: "2026-10-12T17:00:00Z",
        quota: {
          "gemini-5h": {
            remaining_fraction: 0.95,
            reset_time: "2026-10-12T22:00:00Z",
          },
          "gemini-weekly": {
            remaining_fraction: 0.9,
            reset_time: "2026-10-19T17:00:00Z",
          },
          "3p-5h": {
            remaining_fraction: 1.0,
            reset_time: "2026-10-12T22:00:00Z",
          },
          "3p-weekly": {
            remaining_fraction: 0.85,
            reset_time: "2026-10-19T17:00:00Z",
          },
          "future-experimental-bucket": {
            remaining_fraction: 0.5,
          },
        },
      };

      const pools = parseQuotaBuckets(snapshot);
      expect(pools.gemini.five_hour?.utilization).toBe(5);
      expect(pools.gemini.five_hour?.resets_at).toBe("2026-10-12T22:00:00.000Z");

      expect(pools.gemini.weekly?.utilization).toBe(10);
      expect(pools.gemini.weekly?.resets_at).toBe("2026-10-19T17:00:00.000Z");

      expect(pools.claudePartner.five_hour?.utilization).toBe(0);
      expect(pools.claudePartner.five_hour?.resets_at).toBe("2026-10-12T22:00:00.000Z");

      expect(pools.claudePartner.weekly?.utilization).toBe(15);
      expect(pools.claudePartner.weekly?.resets_at).toBe("2026-10-19T17:00:00.000Z");
    });

    it("does not fabricate missing windows when telemetry is partial", () => {
      const snapshot = {
        product: "antigravity",
        observed_at: "2026-10-12T17:00:00Z",
        quota: {
          "gemini-weekly": {
            remaining_fraction: 0.9,
            reset_time: "2026-10-19T17:00:00Z",
          },
        },
      };

      const pools = parseQuotaBuckets(snapshot);
      expect(pools.gemini.weekly).not.toBeNull();
      expect(pools.gemini.five_hour).toBeNull();
      expect(pools.claudePartner.five_hour).toBeNull();
      expect(pools.claudePartner.weekly).toBeNull();
    });
  });

  describe("manual import parsing", () => {
    it("parses real agy -p \"/usage\" tab-separated output", () => {
      const fixture = `Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-19T16:32:31Z
Gemini Models\tFive Hour Limit Remaining\t98%\t2026-10-12T21:32:31Z
Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-19T16:32:31Z
Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-12T21:32:31Z`;

      const pools = parseManualUsageImport(fixture);
      expect(pools).not.toBeNull();
      expect(pools?.gemini.weekly?.utilization).toBe(0);
      expect(pools?.gemini.five_hour?.utilization).toBe(2);
      expect(pools?.claudePartner.weekly?.utilization).toBe(0);
      expect(pools?.claudePartner.five_hour?.utilization).toBe(0);
    });

    it("parses agy -p \"/usage\" JSON command output format", () => {
      const jsonFixture = JSON.stringify({
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    id: "gemini-weekly",
                    name: "Weekly Limit Remaining",
                    remaining_fraction: 0.992,
                    reset_time: "2026-10-19T17:19:49Z",
                  },
                  {
                    id: "gemini-5h",
                    name: "Five Hour Limit Remaining",
                    remaining_fraction: 0.952,
                    reset_time: "2026-10-12T22:19:49Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  {
                    id: "3p-weekly",
                    remaining_fraction: 1.0,
                    reset_time: "2026-10-19T17:32:06Z",
                  },
                  {
                    id: "3p-5h",
                    remaining_fraction: 1.0,
                    reset_time: "2026-10-12T22:32:06Z",
                  },
                ],
              },
            ],
          },
        },
      });

      const pools = parseManualUsageImport(jsonFixture);
      expect(pools).not.toBeNull();
      expect(pools?.gemini.weekly?.utilization).toBe(0.8);
      expect(pools?.gemini.five_hour?.utilization).toBe(4.8);
      expect(pools?.claudePartner.weekly?.utilization).toBe(0);
      expect(pools?.claudePartner.five_hour?.utilization).toBe(0);
    });
  });

  describe("dashboard stream creation", () => {
    it("builds two isolated streams with expected labels, limits, and mascot keys", () => {
      const pools = {
        gemini: {
          five_hour: { utilization: 5, resets_at: "2026-10-12T22:00:00Z" },
          weekly: { utilization: 10, resets_at: "2026-10-19T17:00:00Z" },
        },
        claudePartner: {
          five_hour: { utilization: 0, resets_at: "2026-10-12T22:00:00Z" },
          weekly: { utilization: 2, resets_at: "2026-10-19T17:00:00Z" },
        },
        email: "quekm@example.com",
        planTier: "Pro",
        observedAt: "2026-10-12T17:00:00Z",
      };

      const streams = buildGoogleUsageStreams(pools, { state: "live" });
      expect(streams).toHaveLength(2);

      const geminiStream = streams.find((s) => s.source === GOOGLE_GEMINI_SOURCE);
      expect(geminiStream).toBeDefined();
      expect(geminiStream?.label).toBe(GOOGLE_GEMINI_LABEL);
      expect(geminiStream?.account_email).toBe("quekm@example.com");
      expect(geminiStream?.five_hour?.utilization).toBe(5);
      expect(geminiStream?.seven_day?.utilization).toBe(10);
      expect(geminiStream?.limits).toHaveLength(2);
      expect(geminiStream?.limits?.[0].key).toBe("session");
      expect(geminiStream?.limits?.[1].key).toBe("weekly_all");

      const partnerStream = streams.find((s) => s.source === GOOGLE_CLAUDE_SOURCE);
      expect(partnerStream).toBeDefined();
      expect(partnerStream?.label).toBe(GOOGLE_CLAUDE_LABEL);
      expect(partnerStream?.account_email).toBe("quekm@example.com");
      expect(partnerStream?.five_hour?.utilization).toBe(0);
      expect(partnerStream?.seven_day?.utilization).toBe(2);
      expect(partnerStream?.limits).toHaveLength(2);
      expect(partnerStream?.limits?.[0].key).toBe("session");
      expect(partnerStream?.limits?.[1].key).toBe("weekly_all");
    });
  });
});
