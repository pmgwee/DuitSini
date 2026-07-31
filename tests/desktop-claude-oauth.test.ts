import { afterEach, describe, expect, it, vi } from "vitest";
import { credSources, fetchProSnapshot } from "../desktop/src/collectors/claude-oauth";

const ORIGINAL_SUB_DIR = process.env.CLAUDE_SUB_CONFIG_DIR;
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (ORIGINAL_SUB_DIR === undefined) delete process.env.CLAUDE_SUB_CONFIG_DIR;
  else process.env.CLAUDE_SUB_CONFIG_DIR = ORIGINAL_SUB_DIR;
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  vi.unstubAllGlobals();
});

const credentials = (accessToken: string) => ({
  claudeAiOauth: {
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: Date.now() + 60 * 60_000,
    scopes: ["user:profile", "user:inference"],
  },
});

const usageResponse = (utilization: number) =>
  new Response(
    JSON.stringify({
      five_hour: { utilization, resets_at: "2026-08-01T05:00:00.000Z" },
      seven_day: { utilization: utilization + 1, resets_at: "2026-08-07T05:00:00.000Z" },
      limits: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("Claude credential source ownership", () => {
  it("marks only secondary file profiles as dedicated renewal candidates", () => {
    process.env.CLAUDE_SUB_CONFIG_DIR = "D:\\tracked-claude";
    process.env.CLAUDE_CONFIG_DIR = "D:\\active-claude";

    const sources = credSources();
    const keychainIndex = sources.findIndex((source) => source.path === null);

    expect(keychainIndex).toBeGreaterThan(0);
    expect(sources.slice(0, keychainIndex).map((source) => source.dedicated)).toEqual([
      true,
      true,
      true,
    ]);
    expect(sources.slice(keychainIndex).map((source) => source.dedicated)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("keeps a normal Claude Code profile on the existing read-only usage path", async () => {
    const renewal = { renewIfNeeded: vi.fn(() => Promise.reject(new Error("must not renew"))) };
    const fetcher = vi.fn(async () => usageResponse(12));

    const result = await fetchProSnapshot(
      () => 1,
      renewal as never,
      undefined,
      {
        sources: [
          {
            label: "normal profile",
            path: "C:\\Users\\member\\.claude\\.credentials.json",
            dedicated: false,
            read: async () => credentials("normal-token"),
          },
        ],
        fetcher,
      } as never,
    );

    expect(result.sourceLabel).toBe("normal profile");
    expect(result.snapshot.five_hour?.utilization).toBe(12);
    expect(renewal.renewIfNeeded).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("continues from a rejected dedicated profile to a healthy normal profile", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(usageResponse(18));

    const result = await fetchProSnapshot(
      () => 1,
      undefined,
      undefined,
      {
        sources: [
          {
            label: "dedicated profile",
            path: "C:\\Users\\member\\.claude-pro\\.credentials.json",
            dedicated: true,
            read: async () => credentials("stale-token"),
          },
          {
            label: "normal profile",
            path: "C:\\Users\\member\\.claude\\.credentials.json",
            dedicated: false,
            read: async () => credentials("fresh-token"),
          },
        ],
        fetcher,
      } as never,
    );

    expect(result.sourceLabel).toBe("normal profile");
    expect(result.snapshot.five_hour?.utilization).toBe(18);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
