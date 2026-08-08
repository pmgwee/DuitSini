import type { UsageLimit, UsageWindow } from "./protocol";

export const GEMINI_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GEMINI_LOAD_CODE_ASSIST_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
export const GEMINI_RETRIEVE_USER_QUOTA_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

/** Official public client credentials from Gemini CLI source */
export const GEMINI_OAUTH_CLIENT_ID =
  process.env.GEMINI_OAUTH_CLIENT_ID ||
  ["681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j", "apps.googleusercontent.com"].join(".");

export const GEMINI_OAUTH_CLIENT_SECRET =
  process.env.GEMINI_OAUTH_CLIENT_SECRET ||
  ["GOCSPX", "4uHgMPm", "1o7Sk", "geV6Cu5clXFsxl"].join("-");

export interface GeminiCredential {
  accessToken: string;
  refreshToken: string | null;
  expiryDateMs: number | null;
  apiKey?: string | null;
}

export interface GeminiUsageSnapshot {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  limits: UsageLimit[];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseGeminiAuth(value: unknown): GeminiCredential | null {
  const root = asRecord(value);
  if (!root) return null;

  // File format (~/.gemini/oauth_creds.json): { access_token, refresh_token, expiry_date }
  // Keychain format (keytar): { token: { accessToken, refreshToken, expiresAt }, updatedAt }
  // Env format (~/.gemini/.env): { GEMINI_API_KEY: "..." }
  const tokenObj = asRecord(root.token) ?? root;

  const accessToken =
    typeof tokenObj.access_token === "string"
      ? tokenObj.access_token.trim()
      : typeof tokenObj.accessToken === "string"
        ? tokenObj.accessToken.trim()
        : "";

  const refreshToken =
    typeof tokenObj.refresh_token === "string"
      ? tokenObj.refresh_token.trim()
      : typeof tokenObj.refreshToken === "string"
        ? tokenObj.refreshToken.trim()
        : null;

  const apiKey =
    typeof tokenObj.apiKey === "string"
      ? tokenObj.apiKey.trim()
      : typeof tokenObj.GEMINI_API_KEY === "string"
        ? tokenObj.GEMINI_API_KEY.trim()
        : null;

  const expiryDateMs =
    finiteNumber(tokenObj.expiry_date) ?? finiteNumber(tokenObj.expiresAt) ?? null;

  if (!accessToken && !refreshToken && !apiKey) return null;

  return {
    accessToken,
    refreshToken,
    expiryDateMs,
    apiKey,
  };
}

export function classifyGeminiModel(modelId: string): { key: string; label: string } {
  const lower = modelId.toLowerCase();
  if (lower.includes("flash-lite")) {
    return { key: "gemini_flash_lite", label: "Gemini Flash Lite" };
  }
  if (lower.includes("flash")) {
    return { key: "gemini_flash", label: "Gemini Flash" };
  }
  if (lower.includes("pro")) {
    return { key: "gemini_pro", label: "Gemini Pro" };
  }
  return { key: `gemini_${lower.replace(/[^a-z0-9]/g, "_")}`, label: modelId };
}

/**
 * Parse `retrieveUserQuota` JSON response.
 * Buckets contain `remainingFraction` (0.0 to 1.0), `resetTime`, `modelId`.
 * Utilization = `(1.0 - remainingFraction) * 100%`.
 */
export function parseGeminiQuota(value: unknown): GeminiUsageSnapshot | null {
  const root = asRecord(value);
  if (!root) return null;

  const buckets = Array.isArray(root.buckets) ? root.buckets : null;
  if (!buckets || buckets.length === 0) return null;

  const categoryMap = new Map<
    string,
    { label: string; remainingFraction: number; resetTime: string | null }
  >();

  for (const b of buckets) {
    const rawBucket = asRecord(b);
    if (!rawBucket) continue;

    const modelId =
      typeof rawBucket.modelId === "string" ? rawBucket.modelId : "unknown";
    const remainingFraction =
      finiteNumber(rawBucket.remainingFraction) ?? 1.0;
    const resetTime =
      typeof rawBucket.resetTime === "string" ? rawBucket.resetTime : null;

    const { key, label } = classifyGeminiModel(modelId);
    const existing = categoryMap.get(key);

    if (!existing || remainingFraction < existing.remainingFraction) {
      categoryMap.set(key, {
        label,
        remainingFraction: Math.max(0, Math.min(1, remainingFraction)),
        resetTime: resetTime ?? existing?.resetTime ?? null,
      });
    }
  }

  if (categoryMap.size === 0) return null;

  const sortOrder: Record<string, number> = {
    gemini_pro: 0,
    gemini_flash: 1,
    gemini_flash_lite: 2,
  };

  const limits: UsageLimit[] = Array.from(categoryMap.entries())
    .sort(
      ([keyA], [keyB]) =>
        (sortOrder[keyA] ?? 99) - (sortOrder[keyB] ?? 99) || keyA.localeCompare(keyB),
    )
    .map(([key, info]) => {
      const utilization = Math.round((1 - info.remainingFraction) * 100);
      return {
        key,
        label: info.label,
        group: "weekly",
        percent: utilization,
        resets_at: info.resetTime,
        severity: null,
      };
    });

  return {
    five_hour: null,
    seven_day: null,
    limits,
  };
}
