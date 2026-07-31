import { describe, expect, it, vi } from "vitest";
import {
  AllCodexCredentialsRejectedError,
  NoCodexCredentialsError,
  codexAuthPaths,
  fetchCodexSnapshot,
  type CodexCredentialSource,
} from "../desktop/src/collectors/codex";
import { CODEX_USAGE_URL } from "../lib/claude-usage/codex";

const credentials = (accessToken: string, accountId = "account-123") => ({
  auth_mode: "chatgpt",
  tokens: { access_token: accessToken, account_id: accountId },
});

const source = (label: string, value: unknown): CodexCredentialSource => ({
  label,
  read: async () => value,
});

const usageResponse = (used = 7) =>
  new Response(
    JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: used,
          limit_window_seconds: 604_800,
          reset_at: 1_785_999_600,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("codexAuthPaths", () => {
  it("prefers CODEX_HOME and removes a duplicate default path", () => {
    expect(codexAuthPaths("C:\\Users\\member", "D:\\codex-profile")).toEqual([
      "D:\\codex-profile\\auth.json",
      "C:\\Users\\member\\.codex\\auth.json",
    ]);
    expect(codexAuthPaths("C:\\Users\\member", "C:\\Users\\member\\.codex")).toEqual([
      "C:\\Users\\member\\.codex\\auth.json",
    ]);
  });
});

describe("fetchCodexSnapshot", () => {
  it("uses the cc-switch request contract and returns seven-day used percent", async () => {
    const fetcher = vi.fn(async () => usageResponse(7));

    const result = await fetchCodexSnapshot({
      sources: [source("Codex auth file", credentials("token-a"))],
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      CODEX_USAGE_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token-a",
          "ChatGPT-Account-Id": "account-123",
          "User-Agent": "codex-cli",
          Accept: "application/json",
        }),
      }),
    );
    expect(result.sourceLabel).toBe("Codex auth file");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(result.snapshot.seven_day?.utilization).toBe(7);
    expect(result.snapshot.limits?.[0]?.label).toBe("Weekly");
  });

  it("fails over from a stale file to the next live credential source", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(usageResponse(9));

    const result = await fetchCodexSnapshot({
      sources: [
        source("stale file", credentials("stale-token")),
        source("fresh file", credentials("fresh-token", "account-456")),
      ],
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.sourceLabel).toBe("fresh file");
    expect(result.snapshot.seven_day?.utilization).toBe(9);
  });

  it("stops immediately on endpoint-level 429 and preserves retry-after", async () => {
    const fetcher = vi.fn(async () => new Response("", {
      status: 429,
      headers: { "retry-after": "600" },
    }));

    await expect(
      fetchCodexSnapshot({
        sources: [
          source("first", credentials("token-a")),
          source("must not run", credentials("token-b")),
        ],
        fetcher,
      }),
    ).rejects.toMatchObject({ code: 429, retryMs: 600_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("distinguishes missing credentials from rejected credentials", async () => {
    await expect(
      fetchCodexSnapshot({
        sources: [source("empty", null)],
        fetcher: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(NoCodexCredentialsError);

    await expect(
      fetchCodexSnapshot({
        sources: [source("rejected", credentials("bad-token"))],
        fetcher: vi.fn(async () => new Response("", { status: 403 })),
      }),
    ).rejects.toBeInstanceOf(AllCodexCredentialsRejectedError);
  });
});
