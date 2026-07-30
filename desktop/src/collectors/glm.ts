import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CC_SWITCH_DB, CC_SWITCH_JSON } from "../config";
import { retryMsFrom, safeFetch } from "../net";
import { codedError, type ProviderInfo, type Snapshot, type UsageLimit } from "../types";

/**
 * Third-party gateway usage (GLM / z.ai) for a Claude Code that cc-switch has
 * re-routed. Ported from the sharer's `detectProvider` + `fetchGlmUsage`.
 *
 * The provider's key never leaves the machine — only percentages are pushed.
 */

export interface DetectedProvider extends ProviderInfo {
  source: "anthropic" | "zai" | "other";
  authToken: string | null;
  monitorUrl: string | null;
}

/** Public subset that is safe to send upstream — strips the token. */
export function safeProvider(p: DetectedProvider | null): ProviderInfo | null {
  return p ? { name: p.name, gateway_host: p.gateway_host, official: p.official } : null;
}

function classify(name: string | null, baseUrl: string | null, authToken: string | null): DetectedProvider {
  let official = true;
  let host: string | null = null;
  if (baseUrl) {
    try {
      host = new URL(baseUrl).hostname;
      official = host === "anthropic.com" || host.endsWith(".anthropic.com");
    } catch {
      /* unparseable base url → treat as official/unknown */
    }
  }
  const isGlm = !!host && (host === "z.ai" || host.endsWith(".z.ai") || host.includes("bigmodel"));
  return {
    name,
    gateway_host: official ? null : host,
    official,
    source: official ? "anthropic" : isGlm ? "zai" : "other",
    authToken,
    monitorUrl: host ? `https://${host}/api/monitor/usage/quota/limit` : null,
  };
}

/** cc-switch ≥ 3.x: SQLite. Requires node:sqlite (Node 22.5+/Electron 35+). */
async function fromSqlite(): Promise<DetectedProvider | null> {
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(CC_SWITCH_DB, { readOnly: true });
    try {
      const row = db
        .prepare(
          "select name, settings_config from providers where app_type = 'claude' and is_current = 1 limit 1",
        )
        .get() as { name?: string; settings_config?: string } | undefined;
      if (!row) return null;
      let env: Record<string, string> = {};
      try {
        const s = JSON.parse(row.settings_config || "{}");
        env = (s && s.env) || {};
      } catch {
        /* keep the name, skip env */
      }
      return classify(row.name || null, env.ANTHROPIC_BASE_URL || null, env.ANTHROPIC_AUTH_TOKEN || null);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Older cc-switch: a plain JSON config. */
async function fromCcSwitchJson(): Promise<DetectedProvider | null> {
  try {
    const raw = JSON.parse(await readFile(CC_SWITCH_JSON, "utf8")) as Record<string, unknown>;
    const claude = raw.claude as Record<string, unknown> | undefined;
    const providers = (claude?.providers ?? raw.providers) as Record<string, unknown> | undefined;
    const currentId = (claude?.current ?? raw.current) as string | undefined;
    if (!providers || !currentId) return null;
    const p = providers[currentId] as Record<string, unknown> | undefined;
    if (!p) return null;
    const settings = (p.settingsConfig ?? p.settings_config) as Record<string, unknown> | undefined;
    const env = (settings?.env ?? {}) as Record<string, string>;
    return classify(
      (p.name as string) || null,
      env.ANTHROPIC_BASE_URL || null,
      env.ANTHROPIC_AUTH_TOKEN || null,
    );
  } catch {
    return null;
  }
}

/**
 * Last resort: whatever cc-switch actually APPLIED to Claude Code. This is the
 * live truth even if cc-switch's own store moves again.
 */
async function fromClaudeSettings(): Promise<DetectedProvider | null> {
  for (const file of [
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.local.json"),
  ]) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const env = (raw.env ?? {}) as Record<string, string>;
      if (!env.ANTHROPIC_BASE_URL) continue;
      return classify(null, env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN || null);
    } catch {
      continue;
    }
  }
  return null;
}

/** Detect the currently-active Claude provider, whichever store holds it. */
export async function detectProvider(): Promise<DetectedProvider | null> {
  return (await fromSqlite()) ?? (await fromCcSwitchJson()) ?? (await fromClaudeSettings());
}

/**
 * Fetch gateway quota. Note the Authorization header carries the raw key with NO
 * `Bearer ` prefix — that is what this endpoint expects.
 *
 * unit=3/number=5 is the 5-hour window; unit=6/number=1 is the weekly window.
 * TIME_LIMIT rows (MCP tool minutes) are deliberately skipped.
 */
export async function fetchGlmUsage(provider: DetectedProvider): Promise<Snapshot> {
  if (!provider.monitorUrl || !provider.authToken) {
    throw new Error("No gateway key available for the active provider.");
  }

  const r = await safeFetch(provider.monitorUrl, {
    headers: {
      Authorization: provider.authToken,
      "Accept-Language": "en-US,en",
      "Content-Type": "application/json",
    },
  });

  if (r.status === 401 || r.status === 403) {
    throw codedError(`Your gateway key was rejected (${r.status}).`, r.status);
  }
  if (r.status === 429) {
    const ra = r.headers.get("retry-after");
    throw codedError(
      `Gateway rate-limited (429)${ra ? ` retry-after=${ra}s` : ""}`,
      429,
      retryMsFrom(ra, null),
    );
  }
  if (!r.ok) throw new Error(`Gateway usage check failed (${r.status}).`);

  const j = (await r.json()) as { data?: { limits?: Record<string, unknown>[] } };
  const list = Array.isArray(j?.data?.limits) ? j.data!.limits! : [];

  let five: { utilization: number | null; resets_at: string | null } | null = null;
  let week: { utilization: number | null; resets_at: string | null } | null = null;

  for (const l of list) {
    if (l.type !== "TOKENS_LIMIT") continue;
    const pct = typeof l.percentage === "number" ? l.percentage : null;
    const resets =
      typeof l.nextResetTime === "number" ? new Date(l.nextResetTime).toISOString() : null;
    if (l.unit === 3 && l.number === 5) five = { utilization: pct, resets_at: resets };
    else if (l.unit === 6 && l.number === 1) week = { utilization: pct, resets_at: resets };
  }

  const limits: UsageLimit[] = [];
  if (five) {
    limits.push({
      key: "session",
      label: "Current session",
      group: "session",
      percent: five.utilization,
      resets_at: five.resets_at,
      severity: null,
    });
  }
  if (week) {
    limits.push({
      key: "weekly_all",
      label: "Weekly",
      group: "weekly",
      percent: week.utilization,
      resets_at: week.resets_at,
      severity: null,
    });
  }

  return { five_hour: five, seven_day: week, limits: limits.length ? limits : null };
}
