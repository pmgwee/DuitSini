import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  REFRESH_COOLDOWNS_MS,
  reauthHold,
  refresh429Hold,
  token5xxHold,
} from "../../../lib/bridge/sharer/backoff";
import { UA } from "../config";
import { retryMsFrom, safeFetch } from "../net";
import type { UsageTracker } from "../tracker";
import { codedError } from "../types";
import type { RenewalBroker } from "./claude-oauth";

/**
 * On-demand token refresh via a DIRECT `grant_type=refresh_token` POST — the
 * v7 policy, resurrected behind the `renewal_mode=direct-post` flag (F5).
 *
 * This is the alternative to `claude-cli-renewal.ts` (which delegates to
 * `claude auth login --claudeai`). The F5 evaluation found that `auth login`'s
 * full PKCE re-authorization is rotation/concurrency-fragile
 * (anthropics/claude-code #25609/#24317), while a single serialized refresh
 * POST that atomically persists the rotated refresh token avoids that class.
 * Whether it beats cli-renew's ~24–48h ceiling is what the F5 trial measures.
 *
 * ─────────────────────────────────────────────────────────────────────────
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
 * `renewIfNeeded` NEVER throws a cooldown at the caller. Every gate and every
 * failure returns the current token instead. Refresh is pure upside; the
 * credential walk in `claude-oauth.ts` stays the only failure authority.
 * ─────────────────────────────────────────────────────────────────────────
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
  /** F3: a 4xx means the refresh token is dead — only a fresh login clears it. */
  requiresRelogin?: boolean;
  /** One-way digest of access+refresh, used to spot an external re-login. */
  fingerprint?: string;
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

function fingerprintOf(o: OAuthEntry | null): string {
  return createHash("sha256")
    .update(o?.accessToken || "")
    .update("\0")
    .update(o?.refreshToken || "")
    .digest("hex")
    .slice(0, 20);
}

function isFresh(o: OAuthEntry | null, now: number): boolean {
  return Boolean(o?.accessToken && typeof o.expiresAt === "number" && o.expiresAt > now + EXPIRY_BUFFER_MS);
}

interface RefreshManagerDeps {
  now?: () => number;
  fetcher?: typeof safeFetch;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  tracker?: Pick<UsageTracker, "event">;
  log?: (line: string) => void;
  initialState?: Record<string, unknown>;
}

const jitterSleepMs = () => 200 + Math.floor(Math.random() * 800);

/**
 * Renewal broker that talks to Anthropic's token endpoint directly. Behaviour-
 * equivalent to the v7 sharer refresh; I/O is injected so the policy is unit-
 * testable without network or filesystem.
 */
export class RefreshManager implements RenewalBroker {
  private readonly now: () => number;
  private readonly fetcher: typeof safeFetch;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly writeFile: (path: string, data: string) => Promise<void>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tracker?: Pick<UsageTracker, "event">;
  private readonly log: (line: string) => void;
  private readonly state = new Map<string, RefreshState>();
  private lastAttemptAt = 0;

  constructor(deps: RefreshManagerDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetcher ?? safeFetch;
    this.readFile =
      deps.readFile ??
      (async (path: string) => fsReadFile(path, "utf8"));
    this.writeFile =
      deps.writeFile ??
      ((path, data) => fsWriteFile(path, data, { encoding: "utf8", mode: 0o600 }));
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.tracker = deps.tracker;
    this.log = deps.log ?? (() => {});
    if (deps.initialState) {
      for (const [k, v] of Object.entries(deps.initialState)) {
        if (v && typeof v === "object") this.state.set(k, v as RefreshState);
      }
    }
  }

  exportState(): Record<string, unknown> {
    return Object.fromEntries(this.state);
  }

  /** F3: a dedicated profile whose refresh token is dead (4xx) — don't hammer it. */
  terminalPath(): string | undefined {
    for (const [path, s] of this.state) {
      if (s.requiresRelogin) return path;
    }
    return undefined;
  }

  /** F3: a fresh external sign-in landed on disk → clear the dead state. */
  async externalReloginDetected(path: string): Promise<boolean> {
    const st = this.state.get(path);
    if (!st?.requiresRelogin) return false;
    try {
      const o = oauthEntryOf(JSON.parse(await this.readFile(path)));
      const fp = fingerprintOf(o);
      if (fp === st.fingerprint || !isFresh(o, this.now())) return false;
      st.requiresRelogin = false;
      st.blockedUntil = 0;
      st.streak = 0;
      st.fingerprint = fp;
      st.lastOkAt = this.now();
      return true;
    } catch {
      return false;
    }
  }

  private get(path: string): RefreshState {
    let s = this.state.get(path);
    if (!s) {
      s = {};
      this.state.set(path, s);
    }
    return s;
  }

  async renewIfNeeded(
    creds: unknown,
    path: string,
    options: { force?: boolean } = {},
  ): Promise<string | null> {
    const force = options.force ?? false;
    const o = oauthEntryOf(creds);
    if (!o?.accessToken) return null;
    if (!o.refreshToken) return o.accessToken;

    const st = this.get(path);
    st.fingerprint = fingerprintOf(o);

    const now = this.now();
    const exp = typeof o.expiresAt === "number" ? o.expiresAt : 0;

    // No early/scheduled refresh, ever. This single condition is the difference
    // between v7 and the v3 behaviour that caused the lockouts.
    if (!force && now < exp - EXPIRY_BUFFER_MS) return o.accessToken;
    if (st.blockedUntil && now < st.blockedUntil) return o.accessToken;
    // `force` deliberately cannot bypass this one: it bounds the pathological
    // case where a genuinely new token still answers 401.
    if (st.lastOkAt && now - st.lastOkAt < REFRESH_MIN_OK_GAP_MS) return o.accessToken;
    if (now - this.lastAttemptAt < REFRESH_MIN_MS) return o.accessToken;

    this.lastAttemptAt = now;
    st.lastAttemptAt = now;
    this.tracker?.event("refresh_start", {
      source: path,
      force,
      expiresAt: exp || null,
      minsToExpiry: exp ? Math.round((exp - now) / 60_000) : null,
      streak: st.streak ?? 0,
    });

    try {
      const token = await this.refreshOrAdopt(creds, path, exp);
      st.blockedUntil = 0;
      st.streak = 0;
      st.lastOkAt = this.now();
      st.requiresRelogin = false;
      return token;
    } catch (e) {
      this.arm(st, e as { code?: number | string; retryMs?: number; message?: string });
      this.tracker?.event("refresh_hold", {
        source: path,
        blockedUntil: st.blockedUntil || null,
        streak: st.streak ?? 0,
        reason: (e as { code?: number | string }).code ?? "error",
      });
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
        this.now() + refresh429Hold(streak, e.retryMs, Math.floor(Math.random() * 180_000));
      this.log(
        `[Claude] refresh rate-limited; holding ${Math.round(
          (st.blockedUntil - this.now()) / 60_000,
        )}m (ladder ${streak}/${REFRESH_COOLDOWNS_MS.length})`,
      );
    } else if (e.code === "reauth") {
      st.blockedUntil = this.now() + reauthHold();
      // F3: a dead refresh token only clears via a fresh login. Mark it dead so
      // the scheduler stops spending refresh POSTs (and usage calls) on it and
      // surfaces it for one-click recovery; never loop a rejected token.
      st.requiresRelogin = true;
      this.log("[Claude] refresh token rejected — a fresh sign-in is required.");
    } else if (e.code === "5xx") {
      st.blockedUntil = this.now() + token5xxHold();
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
   */
  private async refreshOrAdopt(creds: unknown, path: string, staleExp: number): Promise<string> {
    await this.sleep(jitterSleepMs());
    // Re-read the file so we can either ADOPT a fresher token another process
    // wrote, or refresh the FRESH object (preserving sibling fields on
    // write-back). Only the READ is fault-tolerant: a refresh FAILURE (4xx/429/
    // 5xx) from `postRefresh` must propagate, not get caught here and trigger a
    // second POST on the same dead token — that double-POST is exactly the kind
    // of loop that flags a login.
    let fresh: unknown = null;
    try {
      fresh = JSON.parse(await this.readFile(path));
    } catch {
      // Unreadable or torn write — fall through to the credentials we were handed.
    }
    const fo = oauthEntryOf(fresh);
    if (
      fo?.accessToken &&
      typeof fo.expiresAt === "number" &&
      fo.expiresAt > staleExp &&
      this.now() < fo.expiresAt - EXPIRY_BUFFER_MS
    ) {
      this.log("[Claude] adopted a fresher sign-in from disk (another process refreshed it).");
      this.tracker?.event("refresh_adopt", { source: path, expiresAt: fo.expiresAt });
      return fo.accessToken;
    }
    // Refresh the FRESH file object (if we have one with a refresh token) so the
    // write-back preserves whatever else the newest version of the file holds.
    if (fo?.refreshToken) return await this.postRefresh(fresh, path);
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
        resp = await this.fetcher(url, {
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
          typeof o?.expiresAt === "number" ? Math.round((this.now() - o.expiresAt) / 60_000) : null;
        this.tracker?.event("refresh_429", { source: path, endpoint: url, retryAfter: ra, reset, tokenAgeMin: ageMin });
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
        const cls = resp.status < 500 ? "reauth" : "5xx";
        this.tracker?.event(cls === "reauth" ? "refresh_reauth" : "refresh_5xx", {
          source: path,
          endpoint: url,
          status: resp.status,
        });
        throw codedError(`Could not refresh the sign-in (${resp.status}).`, cls);
      }

      const j = (await resp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!j.access_token) throw new Error("Refresh returned no token.");

      // Mutate the oauth entry IN PLACE inside the whole parsed file, then write
      // the whole file back — sibling fields (mcpOAuth, …) and whichever key
      // spelling the file uses both survive. The rotated refresh token is
      // persisted BEFORE the access token is used; never hold one in memory
      // across a POST that may have rotated it.
      o.accessToken = j.access_token;
      if (j.refresh_token) o.refreshToken = j.refresh_token;
      const newExpiresAt = this.now() + (j.expires_in || 3600) * 1000;
      o.expiresAt = newExpiresAt;
      await this.writeFile(path, JSON.stringify(creds, null, 2));

      this.tracker?.event("refresh_ok", {
        source: path,
        endpoint: url,
        expiresIn: j.expires_in || 3600,
        newExpiresAt,
        rotatedRefreshToken: !!j.refresh_token,
      });
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
