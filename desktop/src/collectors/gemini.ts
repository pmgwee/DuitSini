import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GEMINI_LOAD_CODE_ASSIST_URL,
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET,
  GEMINI_OAUTH_TOKEN_URL,
  GEMINI_RETRIEVE_USER_QUOTA_URL,
  parseGeminiAuth,
  parseGeminiQuota,
  type GeminiUsageSnapshot,
} from "../../../lib/claude-usage/gemini";
import { retryMsFrom, safeFetch } from "../net";
import { codedError, type Snapshot } from "../types";
import { fetchGeminiWebSnapshot } from "./gemini-web";

export interface GeminiCredentialSource {
  label: string;
  read: () => Promise<unknown>;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchGeminiOptions {
  sources?: GeminiCredentialSource[];
  fetcher?: Fetcher;
  getGoogleCookies?: () => Promise<string | null>;
  persistedCookie?: string | null;
  onCookieFound?: (cookie: string) => void;
}

export interface GeminiResult {
  snapshot: Snapshot;
  sourceLabel: string;
}

export class NoGeminiCredentialsError extends Error {
  constructor() {
    super("No Google Gemini sign-in found on this machine.");
    this.name = "NoGeminiCredentialsError";
  }
}

export class AllGeminiCredentialsRejectedError extends Error {
  constructor(public readonly rejected: string[]) {
    super(
      "The Google Gemini sign-in was rejected. Sign in with Gemini CLI again; " +
        "the refreshed login will be detected automatically.",
    );
    this.name = "AllGeminiCredentialsRejectedError";
  }
}

export function geminiAuthPaths(home = homedir()): string[] {
  const geminiConfigDir = process.env.GEMINI_CONFIG_DIR;
  const geminiHome = process.env.GEMINI_HOME;
  const candidates = [
    geminiConfigDir ? join(geminiConfigDir, "oauth_creds.json") : null,
    geminiHome ? join(geminiHome, "oauth_creds.json") : null,
    join(home, ".gemini-pro", "oauth_creds.json"),
    join(home, ".gemini", "oauth_creds.json"),
    join(home, ".gemini", "credentials.json"),
    join(home, ".config", "gemini", "oauth_creds.json"),
  ].filter((p): p is string => Boolean(p));

  const seen = new Set<string>();
  return candidates.filter((path) => {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fileSource(path: string): GeminiCredentialSource {
  return {
    label: path,
    read: async () => {
      try {
        const content = await readFile(path, "utf8");
        if (path.endsWith(".env")) {
          const map: Record<string, string> = {};
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const [k, v] = trimmed.split("=");
            if (k && v) map[k.trim()] = v.trim();
          }
          return map;
        }
        return JSON.parse(content);
      } catch {
        return null;
      }
    },
  };
}

export function geminiCredentialSources(): GeminiCredentialSource[] {
  const sources = geminiAuthPaths().map(fileSource);
  if (process.env.GEMINI_API_KEY) {
    sources.unshift({
      label: "process.env.GEMINI_API_KEY",
      read: async () => ({ GEMINI_API_KEY: process.env.GEMINI_API_KEY }),
    });
  }
  return sources;
}

function asSnapshot(snapshot: GeminiUsageSnapshot): Snapshot {
  return {
    five_hour: snapshot.five_hour,
    seven_day: snapshot.seven_day,
    limits: snapshot.limits,
  };
}

async function refreshAccessToken(
  refreshToken: string,
  fetcher: Fetcher,
): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetcher(GEMINI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) return null;
    const json = (await response.json()) as Record<string, unknown>;
    return typeof json.access_token === "string" ? json.access_token : null;
  } catch {
    return null;
  }
}

/**
 * Fetch Gemini quota.
 * 1. Try Gemini web session cookie (gemini.google.com/usage) first for Pro subscription limits.
 * 2. If API Key is present, ping generativelanguage.googleapis.com models endpoint.
 * 3. If OAuth token is present, try access_token & auto-refresh via Cloud Code endpoints.
 */
export async function fetchGeminiSnapshot(
  options: FetchGeminiOptions = {},
): Promise<GeminiResult> {
  const fetcher = options.fetcher ?? safeFetch;

  // 1. Prioritize Gemini Web Pro subscription limits (gemini.google.com/usage)
  try {
    const webResult = await fetchGeminiWebSnapshot({
      fetcher,
      getGoogleCookies: options.getGoogleCookies,
      persistedCookie: options.persistedCookie,
      onCookieFound: options.onCookieFound,
    });
    return webResult;
  } catch {
    /* Fall through to CLI / API key if web session cookie is not available */
  }

  const sources = options.sources ?? geminiCredentialSources();
  const rejected: string[] = [];
  let sawCredentials = false;

  for (const source of sources) {
    const credential = parseGeminiAuth(await source.read());
    if (!credential) continue;
    sawCredentials = true;

    // API Key path (Google AI Studio)
    if (credential.apiKey) {
      const resp = await fetcher(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${credential.apiKey}`,
      );
      if (resp.ok) {
        const snapshot: Snapshot = {
          five_hour: null,
          seven_day: null,
          limits: [
            { key: "gemini_pro", label: "Gemini Pro", group: "weekly", percent: 0, resets_at: null },
            { key: "gemini_flash", label: "Gemini Flash", group: "weekly", percent: 0, resets_at: null },
          ],
        };
        return { snapshot, sourceLabel: source.label };
      }
      if (resp.status === 401 || resp.status === 403) {
        rejected.push(`${source.label} (${resp.status})`);
        continue;
      }
    }

    let accessToken = credential.accessToken;
    const isExpired =
      credential.expiryDateMs !== null && credential.expiryDateMs <= Date.now();

    if (isExpired && credential.refreshToken) {
      const refreshed = await refreshAccessToken(credential.refreshToken, fetcher);
      if (refreshed) {
        accessToken = refreshed;
      }
    }

    if (!accessToken) {
      rejected.push(`${source.label} (token expired)`);
      continue;
    }

    // Step 1: loadCodeAssist
    const loadResp = await fetcher(GEMINI_LOAD_CODE_ASSIST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" },
      }),
    });

    if (loadResp.status === 401 || loadResp.status === 403) {
      // Retry once if we have a refresh token
      if (!isExpired && credential.refreshToken) {
        const refreshed = await refreshAccessToken(credential.refreshToken, fetcher);
        if (refreshed) {
          accessToken = refreshed;
          const retryResp = await fetcher(GEMINI_LOAD_CODE_ASSIST_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" },
            }),
          });
          if (retryResp.ok) {
            const projectData = (await retryResp.json()) as Record<string, unknown>;
            const projObj = projectData.cloudaicompanionProject as Record<string, unknown> | undefined;
            const projectId =
              typeof projObj === "string"
                ? projObj
                : typeof projObj?.id === "string"
                  ? projObj.id
                  : typeof projObj?.projectId === "string"
                    ? projObj.projectId
                    : undefined;

            const quotaResp = await fetcher(GEMINI_RETRIEVE_USER_QUOTA_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(projectId ? { project: projectId } : {}),
            });

            if (quotaResp.ok) {
              const snapshot = parseGeminiQuota(await quotaResp.json());
              if (snapshot) {
                return { snapshot: asSnapshot(snapshot), sourceLabel: source.label };
              }
            }
          }
        }
      }

      rejected.push(`${source.label} (${loadResp.status})`);
      continue;
    }

    if (loadResp.status === 429) {
      throw codedError(
        "Google Gemini usage is rate-limited (429).",
        429,
        retryMsFrom(
          loadResp.headers.get("retry-after"),
          loadResp.headers.get("x-ratelimit-reset"),
        ),
      );
    }

    if (!loadResp.ok) {
      throw codedError(`Google Gemini loadCodeAssist failed (${loadResp.status}).`, loadResp.status);
    }

    const projectData = (await loadResp.json()) as Record<string, unknown>;
    const projObj = projectData.cloudaicompanionProject as Record<string, unknown> | undefined;
    const projectId =
      typeof projObj === "string"
        ? projObj
        : typeof projObj?.id === "string"
          ? projObj.id
          : typeof projObj?.projectId === "string"
            ? projObj.projectId
            : undefined;

    // Step 2: retrieveUserQuota
    const quotaResp = await fetcher(GEMINI_RETRIEVE_USER_QUOTA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    });

    if (quotaResp.status === 401 || quotaResp.status === 403) {
      rejected.push(`${source.label} (${quotaResp.status})`);
      continue;
    }

    if (quotaResp.status === 429) {
      throw codedError(
        "Google Gemini quota check rate-limited (429).",
        429,
        retryMsFrom(
          quotaResp.headers.get("retry-after"),
          quotaResp.headers.get("x-ratelimit-reset"),
        ),
      );
    }

    if (!quotaResp.ok) {
      throw codedError(`Google Gemini retrieveUserQuota failed (${quotaResp.status}).`, quotaResp.status);
    }

    const snapshot = parseGeminiQuota(await quotaResp.json());
    if (!snapshot) {
      throw new Error("Google Gemini returned no recognizable quota buckets.");
    }

    return {
      snapshot: asSnapshot(snapshot),
      sourceLabel: source.label,
    };
  }

  if (!sawCredentials) throw new NoGeminiCredentialsError();
  throw new AllGeminiCredentialsRejectedError(rejected);
}
