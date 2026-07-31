import { describe, expect, it } from "vitest";
import { parseCodexAuth, parseCodexUsage } from "./codex";

describe("parseCodexAuth", () => {
  it("accepts ChatGPT Codex CLI credentials", () => {
    expect(
      parseCodexAuth({
        auth_mode: "chatgpt",
        last_refresh: "2026-07-31T03:00:00.000Z",
        tokens: {
          access_token: "access-token",
          account_id: "account-123",
          refresh_token: "must-not-be-returned",
        },
      }),
    ).toEqual({
      accessToken: "access-token",
      accountId: "account-123",
      lastRefresh: "2026-07-31T03:00:00.000Z",
    });
  });

  it("rejects API-key auth and incomplete credentials", () => {
    expect(
      parseCodexAuth({
        auth_mode: "apikey",
        tokens: { access_token: "access-token", account_id: "account-123" },
      }),
    ).toBeNull();
    expect(
      parseCodexAuth({
        auth_mode: "chatgpt",
        tokens: { access_token: "access-token" },
      }),
    ).toBeNull();
  });
});

describe("parseCodexUsage", () => {
  it("maps five-hour and seven-day windows without inverting used percent", () => {
    const snapshot = parseCodexUsage({
      rate_limit: {
        primary_window: {
          used_percent: 2,
          limit_window_seconds: 18_000,
          reset_at: 1_785_486_000,
        },
        secondary_window: {
          used_percent: 7,
          limit_window_seconds: 604_800,
          reset_at: 1_785_999_600,
        },
      },
    });

    expect(snapshot).toEqual({
      five_hour: { utilization: 2, resets_at: "2026-07-31T08:20:00.000Z" },
      seven_day: { utilization: 7, resets_at: "2026-08-06T07:00:00.000Z" },
      limits: [
        {
          key: "session",
          label: "Current session",
          group: "session",
          percent: 2,
          resets_at: "2026-07-31T08:20:00.000Z",
          severity: null,
        },
        {
          key: "weekly_all",
          label: "Weekly",
          group: "weekly",
          percent: 7,
          resets_at: "2026-08-06T07:00:00.000Z",
          severity: null,
        },
      ],
    });
  });

  it("returns the seven-day limit when it is the only reported window", () => {
    expect(
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 4,
              limit_window_seconds: 604_800,
              reset_after_seconds: 90,
            },
          },
        },
        Date.UTC(2026, 6, 31, 2, 0, 0),
      ),
    ).toEqual({
      five_hour: null,
      seven_day: { utilization: 4, resets_at: "2026-07-31T02:01:30.000Z" },
      limits: [
        {
          key: "weekly_all",
          label: "Weekly",
          group: "weekly",
          percent: 4,
          resets_at: "2026-07-31T02:01:30.000Z",
          severity: null,
        },
      ],
    });
  });

  it("keeps a 30-day window as a clearly labeled structured limit", () => {
    const snapshot = parseCodexUsage({
      rate_limit: {
        secondary_window: {
          used_percent: 12.5,
          limit_window_seconds: 2_592_000,
          reset_at: 1_788_080_400,
        },
      },
    });

    expect(snapshot?.five_hour).toBeNull();
    expect(snapshot?.seven_day).toBeNull();
    expect(snapshot?.limits).toEqual([
      expect.objectContaining({
        key: "monthly_all",
        label: "30-day",
        group: "weekly",
        percent: 12.5,
      }),
    ]);
  });

  it("returns null for responses without usable rate-limit windows", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: null } })).toBeNull();
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "2" } } })).toBeNull();
    expect(parseCodexUsage(null)).toBeNull();
  });
});
