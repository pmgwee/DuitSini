import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCliRenewalManager,
  type ClaudeCliLoginRequest,
  type ClaudeCliRenewalState,
} from "../desktop/src/collectors/claude-cli-renewal";

const NOW = Date.parse("2026-08-01T00:00:00.000Z");
const CREDS_PATH = "C:\\Users\\member\\.claude-pro\\.credentials.json";

const credentials = (
  accessToken: string,
  expiresAt: number,
  refreshToken = "refresh-secret",
) => ({
  claudeAiOauth: {
    accessToken,
    refreshToken,
    expiresAt,
    refreshTokenExpiresAt: NOW + 28 * 86_400_000,
    scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
  },
});

function manager(options?: {
  reads?: unknown[];
  now?: () => number;
  run?: (request: ClaudeCliLoginRequest) => Promise<{ code: number; timedOut?: boolean }>;
  state?: Record<string, ClaudeCliRenewalState>;
}) {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const run = vi.fn(
    options?.run ?? (async () => ({ code: 0 })),
  );
  const queuedReads = [...(options?.reads ?? [])];
  const readCredentials = vi.fn(async () => queuedReads.shift() ?? null);
  const withLock = vi.fn(async (_path: string, task: () => Promise<string | null>) => task());
  const value = new ClaudeCliRenewalManager({
    now: options?.now ?? (() => NOW),
    run,
    readCredentials,
    withLock,
    tracker: { event: (type, data) => events.push({ type, data }) },
    initialState: options?.state,
  });
  return { value, run, readCredentials, withLock, events };
}

describe("ClaudeCliRenewalManager", () => {
  it("returns a healthy access token without launching the CLI", async () => {
    const current = credentials("access-current", NOW + 60 * 60_000);
    const { value, run, withLock } = manager();

    await expect(value.renewIfNeeded(current, CREDS_PATH)).resolves.toBe("access-current");
    expect(run).not.toHaveBeenCalled();
    expect(withLock).not.toHaveBeenCalled();
  });

  it("renews an expiring dedicated login through the official CLI environment", async () => {
    const current = credentials("access-old", NOW + 2 * 60_000);
    const after = credentials("access-new", NOW + 8 * 60 * 60_000, "refresh-rotated");
    const { value, run, events } = manager({ reads: [current, after] });

    await expect(value.renewIfNeeded(current, CREDS_PATH)).resolves.toBe("access-new");

    expect(run).toHaveBeenCalledOnce();
    const request = run.mock.calls[0]![0];
    expect(request).toBeDefined();
    if (!request) throw new Error("Expected a Claude CLI request.");
    expect(request.command).toBe("claude.cmd");
    expect(request.args).toEqual(["auth", "login", "--claudeai"]);
    expect(request.timeoutMs).toBe(30_000);
    expect(request.env.CLAUDE_CONFIG_DIR).toBe("C:\\Users\\member\\.claude-pro");
    expect(request.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe("refresh-secret");
    expect(request.env.CLAUDE_CODE_OAUTH_SCOPES).toBe(
      "user:profile user:inference user:sessions:claude_code",
    );
    expect(request.args.join(" ")).not.toContain("refresh-secret");
    expect(JSON.stringify(events)).not.toContain("refresh-secret");
    expect(JSON.stringify(events)).not.toContain("access-old");
    expect(events.map((event) => event.type)).toEqual(["cli_renew_start", "cli_renew_ok"]);
  });

  it("single-flights concurrent renewal for the same credential path", async () => {
    const current = credentials("access-old", NOW + 2 * 60_000);
    const after = credentials("access-new", NOW + 8 * 60 * 60_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { value, run, withLock } = manager({
      reads: [current, after],
      run: async () => {
        await gate;
        return { code: 0 };
      },
    });

    const first = value.renewIfNeeded(current, CREDS_PATH);
    const second = value.renewIfNeeded(current, CREDS_PATH);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["access-new", "access-new"]);
    expect(run).toHaveBeenCalledOnce();
    expect(withLock).toHaveBeenCalledOnce();
  });

  it("holds a failed fingerprint but immediately retries after official credentials change", async () => {
    const oldCredentials = credentials("access-old", NOW - 1);
    const changedCredentials = credentials("access-changed", NOW - 1, "refresh-changed");
    const after = credentials("access-new", NOW + 8 * 60 * 60_000, "refresh-new");
    const run = vi
      .fn()
      .mockResolvedValueOnce({ code: 1 })
      .mockResolvedValueOnce({ code: 0 });
    const { value } = manager({ reads: [oldCredentials, changedCredentials, after], run });

    await expect(value.renewIfNeeded(oldCredentials, CREDS_PATH)).resolves.toBe("access-old");
    await expect(value.renewIfNeeded(oldCredentials, CREDS_PATH)).resolves.toBe("access-old");
    expect(run).toHaveBeenCalledTimes(1);

    await expect(value.renewIfNeeded(changedCredentials, CREDS_PATH)).resolves.toBe("access-new");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("rejects an unchanged credential file after a nominal CLI success", async () => {
    const current = credentials("access-old", NOW - 1);
    const { value, events } = manager({ reads: [current, current] });

    await expect(value.renewIfNeeded(current, CREDS_PATH, { force: true })).resolves.toBe(
      "access-old",
    );
    expect(events.map((event) => event.type)).toEqual([
      "cli_renew_start",
      "cli_renew_invalid_result",
    ]);
  });

  it("crosses three consecutive eight-hour access-token boundaries without manual login", async () => {
    let clock = NOW;
    const access0 = credentials("access-0", NOW + 2 * 60_000, "refresh-0");
    const access1 = credentials("access-1", NOW + 8 * 60 * 60_000, "refresh-1");
    const access2 = credentials("access-2", NOW + 16 * 60 * 60_000, "refresh-2");
    const access3 = credentials("access-3", NOW + 24 * 60 * 60_000, "refresh-3");
    const { value, run } = manager({
      now: () => clock,
      reads: [access0, access1, access1, access2, access2, access3],
    });

    await expect(value.renewIfNeeded(access0, CREDS_PATH)).resolves.toBe("access-1");
    clock = NOW + 8 * 60 * 60_000 - 2 * 60_000;
    await expect(value.renewIfNeeded(access1, CREDS_PATH)).resolves.toBe("access-2");
    clock = NOW + 16 * 60 * 60_000 - 2 * 60_000;
    await expect(value.renewIfNeeded(access2, CREDS_PATH)).resolves.toBe("access-3");

    expect(run).toHaveBeenCalledTimes(3);
    expect(value.exportState()[CREDS_PATH]?.blockedUntil).toBeUndefined();
  });
});
