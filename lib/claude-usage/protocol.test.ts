import { describe, expect, it } from "vitest";
import {
  PUSH_SECONDS_MIN,
  PUSH_SECONDS_MAX,
  PUSH_SECONDS_DEFAULT,
  FRESHNESS_GRACE_MS,
  clampPushSeconds,
  freshnessWindowMs,
  streamSchema,
  bodySchema,
  windowSchema,
  limitSchema,
} from "./protocol";

describe("cadence constants (v7 verbatim)", () => {
  it("pins PUSH_SECONDS_* and FRESHNESS_GRACE_MS", () => {
    expect(PUSH_SECONDS_MIN).toBe(120);
    expect(PUSH_SECONDS_MAX).toBe(3600);
    expect(PUSH_SECONDS_DEFAULT).toBe(300);
    expect(FRESHNESS_GRACE_MS).toBe(60_000);
  });
});

describe("clampPushSeconds (mirrors v7 loadPushMs / live staleAfterMs)", () => {
  it("clamps into [120, 3600]", () => {
    expect(clampPushSeconds(0)).toBe(120);
    expect(clampPushSeconds(60)).toBe(120);
    expect(clampPushSeconds(120)).toBe(120);
    expect(clampPushSeconds(300)).toBe(300);
    expect(clampPushSeconds(3600)).toBe(3600);
    expect(clampPushSeconds(100_000)).toBe(3600);
  });
});

describe("freshnessWindowMs (live route v6.2: two cycles + 60s grace)", () => {
  it("default cadence 300s -> 2*300*1000 + 60000", () => {
    expect(freshnessWindowMs(300)).toBe(660_000);
  });
  it("clamps before sizing", () => {
    expect(freshnessWindowMs(1)).toBe(2 * 120 * 1000 + 60_000);
    expect(freshnessWindowMs(100_000)).toBe(2 * 3600 * 1000 + 60_000);
  });
});

describe("snapshot schema (mirrors ingest route v7)", () => {
  it("parses a well-formed stream", () => {
    const stream = {
      source: "pro",
      label: "Claude Pro",
      five_hour: { utilization: 0.42, resets_at: "2026-07-26T12:00:00Z" },
      seven_day: null,
      limits: [{ key: "k", label: "lbl", group: "session", percent: 50, resets_at: null }],
      provider: { name: "Anthropic", gateway_host: null, official: true },
    };
    expect(streamSchema.safeParse(stream).success).toBe(true);
  });

  it("parses a full multi-stream push body", () => {
    const body = {
      five_hour: { utilization: 0.5, resets_at: null },
      streams: [{ source: "pro", label: "Claude Pro" }, { source: "glm", label: "GLM" }],
      push_seconds: 300,
      sharer_version: "7",
    };
    expect(bodySchema.safeParse(body).success).toBe(true);
  });

  it("rejects a stream missing required source/label", () => {
    expect(streamSchema.safeParse({ source: "pro" }).success).toBe(false);
  });

  it("rejects an unknown limit group", () => {
    expect(limitSchema.safeParse({ key: "k", label: "l", group: "hourly" }).success).toBe(false);
  });

  it("treats a window as nullable", () => {
    expect(windowSchema.safeParse(null).success).toBe(true);
    expect(windowSchema.safeParse({ utilization: 1, resets_at: null }).success).toBe(true);
  });
});
