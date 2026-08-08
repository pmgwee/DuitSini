import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseGeminiWebUsageHtml,
  type GeminiWebUsageSnapshot,
} from "../../../lib/claude-usage/gemini-web";
import { safeFetch } from "../net";
import { codedError, type Snapshot } from "../types";

export interface GeminiWebCookieSource {
  label: string;
  readCookie: () => Promise<string | null>;
}

export interface GeminiWebResult {
  snapshot: Snapshot;
  sourceLabel: string;
}

export class NoGeminiWebCookiesError extends Error {
  constructor() {
    super("No Gemini web session cookie found on this machine.");
    this.name = "NoGeminiWebCookiesError";
  }
}

export class AllGeminiWebCookiesRejectedError extends Error {
  constructor(public readonly rejected: string[]) {
    super(
      "The Gemini web session cookie was rejected or expired. " +
        "Sign in to gemini.google.com in your browser to update your session.",
    );
    this.name = "AllGeminiWebCookiesRejectedError";
  }
}

export function geminiCookieFilePaths(home = homedir()): string[] {
  return [
    join(home, ".gemini", "cookies.json"),
    join(home, ".gemini", "cookie.txt"),
    join(home, ".gemini", ".env"),
  ];
}

function fileCookieSource(path: string): GeminiWebCookieSource {
  return {
    label: path,
    readCookie: async () => {
      try {
        const content = await readFile(path, "utf8");
        if (path.endsWith(".json")) {
          const json = JSON.parse(content) as Record<string, unknown>;
          if (typeof json.cookie === "string") return json.cookie;
          if (typeof json.__Secure_1PSID === "string") {
            const sid = typeof json.SID === "string" ? `; SID=${json.SID}` : "";
            return `__Secure-1PSID=${json.__Secure_1PSID}${sid}`;
          }
        }
        if (path.endsWith(".env")) {
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("GEMINI_WEB_COOKIE=") || trimmed.startsWith("GEMINI_COOKIE=")) {
              const val = trimmed.split("=").slice(1).join("=").trim();
              return val.replace(/^["']|["']$/g, "");
            }
          }
        }
        if (path.endsWith(".txt")) {
          return content.trim();
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

export function geminiWebCookieSources(
  options: {
    getGoogleCookies?: () => Promise<string | null>;
    persistedCookie?: string | null;
  } = {},
): GeminiWebCookieSource[] {
  const sources: GeminiWebCookieSource[] = geminiCookieFilePaths().map(fileCookieSource);

  if (process.env.GEMINI_WEB_COOKIE) {
    sources.unshift({
      label: "process.env.GEMINI_WEB_COOKIE",
      readCookie: async () => process.env.GEMINI_WEB_COOKIE ?? null,
    });
  }

  if (options.persistedCookie) {
    sources.unshift({
      label: "desktop-store.geminiWebCookie",
      readCookie: async () => options.persistedCookie ?? null,
    });
  }

  if (options.getGoogleCookies) {
    sources.unshift({
      label: "electron.session.cookies",
      readCookie: options.getGoogleCookies,
    });
  }

  return sources;
}

function asSnapshot(snapshot: GeminiWebUsageSnapshot): Snapshot {
  return {
    five_hour: snapshot.five_hour,
    seven_day: snapshot.seven_day,
    limits: snapshot.limits,
  };
}

/**
 * Fetch Gemini Pro subscription usage from `gemini.google.com/usage`.
 */
export async function fetchGeminiWebSnapshot(
  options: {
    sources?: GeminiWebCookieSource[];
    fetcher?: typeof safeFetch;
    getGoogleCookies?: () => Promise<string | null>;
    persistedCookie?: string | null;
    onCookieFound?: (cookie: string) => void;
  } = {},
): Promise<GeminiWebResult> {
  const sources =
    options.sources ??
    geminiWebCookieSources({
      getGoogleCookies: options.getGoogleCookies,
      persistedCookie: options.persistedCookie,
    });
  const fetcher = options.fetcher ?? safeFetch;
  const rejected: string[] = [];
  let sawCookies = false;

  for (const source of sources) {
    const cookie = await source.readCookie();
    if (!cookie) continue;
    sawCookies = true;

    const resp = await fetcher("https://gemini.google.com/usage", {
      headers: {
        Cookie: cookie,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (resp.status === 401 || resp.status === 403 || resp.url.includes("accounts.google.com")) {
      rejected.push(`${source.label} (${resp.status})`);
      continue;
    }

    if (resp.status === 429) {
      throw codedError("gemini.google.com rate-limited (429).", 429);
    }

    if (!resp.ok) {
      throw codedError(`gemini.google.com failed (${resp.status}).`, resp.status);
    }

    const html = await resp.text();
    const snapshot = parseGeminiWebUsageHtml(html);
    if (!snapshot) {
      // If we got 200 OK but HTML couldn't be parsed, try fallback check
      rejected.push(`${source.label} (unparseable HTML / sign-in redirect)`);
      continue;
    }

    if (options.onCookieFound) {
      options.onCookieFound(cookie);
    }

    return {
      snapshot: asSnapshot(snapshot),
      sourceLabel: source.label,
    };
  }

  if (!sawCookies) throw new NoGeminiWebCookiesError();
  throw new AllGeminiWebCookiesRejectedError(rejected);
}
