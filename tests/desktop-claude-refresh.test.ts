import { describe, expect, it, vi } from "vitest";
import { RefreshManager, type RefreshState } from "../desktop/src/collectors/claude-refresh";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const PATH = "C:\\Users\\member\\.claude-pro\\.credentials.json";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const credentials = (accessToken: string, expiresAt: number, refreshToken = "refresh-old") => ({
  claudeAiOauth: { accessToken, refreshToken, expiresAt },
});

/** A minimal Response stand-in for the injected fetcher. */
function response(
  status: number,
  body: unknown,
  headers: Record<string, string | null> = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null } as Headers,
    json: async () => body,
  } as Response;
}

/** The fetcher shape RefreshManager expects (matches net.ts's safeFetch). */
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface Harness {
  value: RefreshManager;
  fetcher: ReturnType<typeof vi.fn>;
  writes: Array<{ path: string; data: string }>;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  setFile: (path: string, data: string) => void;
}

function manager(options?: {
  now?: () => number;
  fetcher?: ReturnType<typeof vi.fn>;
  initialState?: Record<string, unknown>;
  files?: Map<string, string>;
}): Harness {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const files = new Map(options?.files ?? new Map());
  const writes: Array<{ path: string; data: string }> = [];
  const fetcher =
    options?.fetcher ??
    (vi.fn(
      async () =>
        response(200, { access_token: "access-new", refresh_token: "refresh-rotated", expires_in: 28800 }),
    ) as ReturnType<typeof vi.fn>);
  const value = new RefreshManager({
    now: options?.now ?? (() => NOW),
    fetcher: fetcher as unknown as Fetcher,
    readFile: async (p) => files.get(p) ?? "",
    writeFile: async (p, data) => {
      files.set(p, data);
      writes.push({ path: p, data });
    },
    sleep: async () => {},
    tracker: { event: (type, data) => events.push({ type, data }) },
    log: () => {},
    initialState: options?.initialState,
  });
  return { value, fetcher, writes, events, setFile: (p, d) => files.set(p, d) };
}

describe("RefreshManager (F5 direct-POST broker)", () => {
  it("does not refresh a token that is still fresh", async () => {
    const current = credentials("access-current", NOW + 8 * 60 * 60_000);
    const { value, fetcher } = manager();
    await expect(value.renewIfNeeded(current, PATH)).resolves.toBe("access-current");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("POSTs a grant_type=refresh_token JSON body and persists the rotated token", async () => {
    const expired = credentials("access-old", NOW - 1, "refresh-old");
    const { value, fetcher, writes, events } = manager({
      files: new Map([[PATH, JSON.stringify(expired)]]),
    });

    await expect(value.renewIfNeeded(expired, PATH)).resolves.toBe("access-new");

    // One POST to the first endpoint; JSON body, refresh token in the body only.
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body.grant_type).toBe("refresh_token");
    expect(body.client_id).toBe(CLIENT_ID);
    expect(body.refresh_token).toBe("refresh-old");

    // The rotated access + refresh tokens are written back atomically.
    const written = JSON.parse(writes[0]!.data) as { claudeAiOauth: Record<string, unknown> };
    expect(written.claudeAiOauth.accessToken).toBe("access-new");
    expect(written.claudeAiOauth.refreshToken).toBe("refresh-rotated");
    expect(events.map((e) => e.type)).toEqual(["refresh_start", "refresh_ok"]);
    expect(events[1]!.data.rotatedRefreshToken).toBe(true);
  });

  it("a 4xx marks the login dead (terminal) and does not loop", async () => {
    const expired = credentials("access-old", NOW - 1);
    const fetcher = vi.fn(async () => response(400, { error: "invalid_grant" }));
    const { value, fetcher: f, writes } = manager({
      fetcher,
      files: new Map([[PATH, JSON.stringify(expired)]]),
    });

    await expect(value.renewIfNeeded(expired, PATH)).resolves.toBe("access-old");
    expect(f).toHaveBeenCalledTimes(1);
    // No credentials were written (the rotation never happened).
    expect(writes).toHaveLength(0);
    // F3: the login is now terminal.
    expect(value.terminalPath()).toBe(PATH);

    // A second call the same instant does NOT POST again — the reauth hold gates it.
    await value.renewIfNeeded(expired, PATH);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a 429 arms the streak ladder but is not terminal", async () => {
    const expired = credentials("access-old", NOW - 1);
    const fetcher = vi.fn(async () => response(429, {}, { "retry-after": "60" }));
    const { value } = manager({
      fetcher,
      files: new Map([[PATH, JSON.stringify(expired)]]),
    });

    await value.renewIfNeeded(expired, PATH);
    // A 429 is a cooldown, not a dead login.
    expect(value.terminalPath()).toBeUndefined();
    const state = value.exportState()[PATH] as RefreshState;
    expect(state.streak).toBe(1);
    expect(state.blockedUntil).toBeGreaterThan(NOW);
  });

  it("force (a real 401) spends a refresh before real expiry, but the success floor still applies", async () => {
    // Token still has ~1h of life — well outside the 5-min on-demand window.
    const current = credentials("access-old", NOW + 60 * 60_000);
    const { value, fetcher } = manager({
      files: new Map([[PATH, JSON.stringify(current)]]),
    });

    // Without force: no refresh.
    await value.renewIfNeeded(current, PATH);
    expect(fetcher).not.toHaveBeenCalled();

    // With force (the server returned a 401 on this exact token): refresh fires.
    await value.renewIfNeeded(current, PATH, { force: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("F3: a fresh external sign-in on disk clears the terminal state", async () => {
    const dead = credentials("access-old", NOW - 1, "refresh-dead");
    const fresh = credentials("access-fresh", NOW + 8 * 60 * 60_000, "refresh-fresh");
    const fetcher = vi.fn(async () => response(400, { error: "invalid_grant" }));
    const { value, setFile } = manager({
      fetcher,
      files: new Map([[PATH, JSON.stringify(dead)]]),
    });

    // Discover the dead login.
    await value.renewIfNeeded(dead, PATH);
    expect(value.terminalPath()).toBe(PATH);

    // Same dead login still on disk → no recovery.
    await expect(value.externalReloginDetected(PATH)).resolves.toBe(false);
    expect((value.exportState()[PATH] as RefreshState).requiresRelogin).toBe(true);

    // A fresh sign-in lands on disk → terminal state clears.
    setFile(PATH, JSON.stringify(fresh));
    await expect(value.externalReloginDetected(PATH)).resolves.toBe(true);
    expect((value.exportState()[PATH] as RefreshState).requiresRelogin).toBeFalsy();
  });

  it("falls back to the second token endpoint on a 404", async () => {
    const expired = credentials("access-old", NOW - 1);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(404, {}))
      .mockResolvedValueOnce(
        response(200, { access_token: "access-new", refresh_token: "refresh-rotated", expires_in: 28800 }),
      );
    const { value, fetcher: f } = manager({
      fetcher,
      files: new Map([[PATH, JSON.stringify(expired)]]),
    });

    await expect(value.renewIfNeeded(expired, PATH)).resolves.toBe("access-new");
    expect(f).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[0] as [string])[0]).toBe("https://platform.claude.com/v1/oauth/token");
    expect((f.mock.calls[1] as [string])[0]).toBe("https://console.anthropic.com/v1/oauth/token");
  });
});
