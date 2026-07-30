import { readFile, writeFile } from "node:fs/promises";
import {
  REFRESH_COOLDOWNS_MS,
  reauthHold,
  refresh429Hold,
  token5xxHold,
} from "../../../lib/bridge/sharer/backoff";
import { UA } from "../config";
import { retryMsFrom, safeFetch } from "../net";
import { codedError } from "../types";

/**
 * On-demand token refresh — the v7 policy, ported with every guard intact.
 *
 * READ THIS BEFORE LOOSENING ANYTHING HERE. Anthropic's token endpoint flags a
 * login that gets retried in a loop, and only a manual re-login clears the flag.
 * The sharer's v3 generation refreshed EARLY (expiry−3h, jittered) on a 24/7
 * loop and repeatedly bricked logins. v7's fix was not "refresh more carefully"
 * but "refresh only at real expiry, at most once per gate, and degrade to the
 * current token whenever a gate says no".
 *
 * The policy in one line: a token is used AS-IS until 5 minutes before its
 * recorded expiry (or until a real 401 forces our hand), and only then does it
 * cost ONE refresh POST — roughly 1–3 per day at 8h token lifetimes, and fewer
 * still here because a desktop app only runs while it is open.
 *
 * `refreshIfNeeded` NEVER throws a cooldown at the caller. Every gate and every
 * failure returns the current token instead. Refresh is pure upside; the
 * credential walk in `claude-oauth.ts` stays the only failure authority.
 */

const TOKEN_ENDPOINTS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
];
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Refresh this long before the recorded expiry — never earlier. */
const EXPIRY_BUFFER_MS = 300_000;
/** Hard floor between any two refresh attempts, successful or not. */
const REFRESH_MIN_MS = 45_000;
/** Floor after a SUCCESSFUL refresh. Caps a fresh-token-still-401s loop. */
const REFRESH_MIN_OK_GAP_MS = 900_000;

export interface RefreshState {
  blockedUntil?: number;
  streak?: number;
  lastOkAt?: number;
  lastAttemptAt?: number;
}

interface OAuthEntry {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

function oauthEntryOf(creds: unknown): OAuthEntry | null {
  if (!creds || typeof creds !== "object") return null;
  const c = creds as Record<string, unknown>;
  return (c.claudeAiOauth || c["claude.ai_oauth"] || null) as OAuthEntry | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RefreshManager {
  /** Per-credentials-path state, persisted by the caller via `export/import`. */
  private state = new Map<string, RefreshState>();
  private lastAttemptAt = 0;

  constructor(private readonly log: (line: string) => void = () => {}) {}

  importState(s: Record<string, RefreshState> | undefined): void {
    if (!s) return;
    for (const [k, v] of Object.entries(s)) this.state.set(k, v);
  }

  exportState(): Record<string, RefreshState> {
    return Object.fromEntries(this.state);
  }

  private get(path: string): RefreshState {
    let s = this.state.get(path);
    if (!s) {
      s = {};
      this.state.set(path, s);
    }
    return s;
  }

  /** Human-readable reason the UI can show when a refresh is being held off. */
  blockedReason(path: string): string | null {
    const s = this.get(path);
    if (s.blockedUntil && Date.now() < s.blockedUntil) {
      return `sign-in refresh paused until ${new Date(s.blockedUntil).toLocaleTimeString()}`;
    }
    return null;
  }

  /**
   * Decide whether to spend a refresh, and do it if so.
   *
   * @param force set when a real 401 just came back on this exact token — the
   *              server overrules the clock, but every OTHER gate still applies.
   * @returns a usable access token; the CURRENT one whenever a gate declines.
   */
  async refreshIfNeeded(
    creds: unknown,
    path: string,
    force = false,
  ): Promise<string | null> {
    const o = oauthEntryOf(creds);
    if (!o?.accessToken) return null;
    if (!o.refreshToken) return o.accessToken;

    const now = Date.now();
    const exp = typeof o.expiresAt === "number" ? o.expiresAt : 0;

    // No early/scheduled refresh, ever. This single condition is the difference
    // between v7 and the v3 behaviour that caused the lockouts.
    if (!force && now < exp - EXPIRY_BUFFER_MS) return o.accessToken;

    const st = this.get(path);
    if (st.blockedUntil && now < st.blockedUntil) return o.accessToken;
    // `force` deliberately cannot bypass this one: it bounds the pathological
    // case where a genuinely new token still answers 401.
    if (st.lastOkAt && now - st.lastOkAt < REFRESH_MIN_OK_GAP_MS) return o.accessToken;
    if (now - this.lastAttemptAt < REFRESH_MIN_MS) return o.accessToken;

    this.lastAttemptAt = now;
    st.lastAttemptAt = now;

    try {
      const token = await this.refreshOrAdopt(creds, path, exp);
      st.blockedUntil = 0;
      st.streak = 0;
      st.lastOkAt = Date.now();
      return token;
    } catch (e) {
      this.arm(st, e as { code?: number | string; retryMs?: number; message?: string });
      return o.accessToken;
    }
  }

  /** Translate a refresh failure into a persisted hold. */
  private arm(
    st: RefreshState,
    e: { code?: number | string; retryMs?: number; message?: string },
  ): void {
    if (e.code === 429) {
      const streak = (st.streak ?? 0) + 1;
      st.streak = streak;
      st.blockedUntil =
        Date.now() + refresh429Hold(streak, e.retryMs, Math.floor(Math.random() * 180_000));
      this.log(
        `[Claude] refresh rate-limited; holding ${Math.round(
          (st.blockedUntil - Date.now()) / 60_000,
        )}m (ladder ${streak}/${REFRESH_COOLDOWNS_MS.length})`,
      );
    } else if (e.code === "reauth") {
      st.blockedUntil = Date.now() + reauthHold();
      this.log("[Claude] refresh token rejected — a fresh sign-in is required.");
    } else if (e.code === "5xx") {
      st.blockedUntil = Date.now() + token5xxHold();
      this.log("[Claude] token service unavailable; holding 10m.");
    } else {
      this.log(`[Claude] refresh failed: ${e.message ?? "unknown"}`);
    }
  }

  /**
   * Cross-process safety. The endpoint ROTATES the refresh token on success, so
   * two refreshers racing invalidate each other and stampede into a 429 — the
   * exact failure that bricked the login. We jitter briefly, re-read the file,
   * and ADOPT a sibling's fresher token instead of spending our own request.
   *
   * This matters even though the desktop app replaces the sharer: a member may
   * still have the old script running somewhere during the transition.
   */
  private async refreshOrAdopt(creds: unknown, path: string, staleExp: number): Promise<string> {
    await sleep(200 + Math.floor(Math.random() * 800));
    try {
      const fresh = JSON.parse(await readFile(path, "utf8"));
      const fo = oauthEntryOf(fresh);
      if (
        fo?.accessToken &&
        typeof fo.expiresAt === "number" &&
        fo.expiresAt > staleExp &&
        Date.now() < fo.expiresAt - EXPIRY_BUFFER_MS
      ) {
        this.log("[Claude] adopted a fresher sign-in from disk (another process refreshed it).");
        return fo.accessToken;
      }
      // Refresh the FRESH file object so the write-back preserves whatever else
      // the newest version of the file holds.
      if (fo?.refreshToken) return await this.postRefresh(fresh, path);
    } catch {
      // Unreadable or torn write — fall through and refresh what we have.
    }
    return await this.postRefresh(creds, path);
  }

  private async postRefresh(creds: unknown, path: string): Promise<string> {
    const o = oauthEntryOf(creds);
    const rt = o?.refreshToken;
    if (!rt) throw new Error("No refresh token available.");

    let lastErr: unknown;
    for (const url of TOKEN_ENDPOINTS) {
      let resp: Response;
      try {
        resp = await safeFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": UA },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: rt,
            client_id: OAUTH_CLIENT_ID,
          }),
        });
      } catch (e) {
        lastErr = e;
        continue;
      }

      if (resp.status === 404) {
        lastErr = new Error("token endpoint 404");
        continue;
      }
      if (resp.status === 429) {
        const ra = resp.headers.get("retry-after");
        const reset = resp.headers.get("anthropic-ratelimit-unified-reset");
        const ageMin =
          typeof o?.expiresAt === "number" ? Math.round((Date.now() - o.expiresAt) / 60_000) : null;
        throw codedError(
          `Token refresh rate-limited (429)${ra ? ` retry-after=${ra}s` : ""}` +
            `${ageMin === null ? "" : ` tokenAge=${ageMin}m`}`,
          429,
          retryMsFrom(ra, reset),
        );
      }
      if (!resp.ok) {
        // 4xx: this refresh token is finished — revoked, or a rotation response
        // was lost in transit. Retrying can never fix it; only a fresh login
        // can, and blind retries are exactly what gets a login flagged.
        throw codedError(
          `Could not refresh the sign-in (${resp.status}).`,
          resp.status < 500 ? "reauth" : "5xx",
        );
      }

      const j = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!j.access_token) throw new Error("Refresh returned no token.");

      // Mutate the oauth entry IN PLACE inside the whole parsed file, then write
      // the whole file back — sibling fields (mcpOAuth, …) and whichever key
      // spelling the file uses both survive.
      o.accessToken = j.access_token;
      if (j.refresh_token) o.refreshToken = j.refresh_token;
      o.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
      await writeFile(path, JSON.stringify(creds, null, 2), { encoding: "utf8", mode: 0o600 });

      this.log(
        `[Claude] refreshed the sign-in (valid ~${Math.max(
          1,
          Math.round((j.expires_in || 3600) / 3600),
        )}h).`,
      );
      return j.access_token;
    }
    throw lastErr instanceof Error ? lastErr : new Error("Refresh failed.");
  }
}
