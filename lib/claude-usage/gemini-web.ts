import type { UsageLimit, UsageWindow } from "./protocol";

export interface GeminiWebUsageSnapshot {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  limits: UsageLimit[];
}

/**
 * Parse a civil reset time string from gemini.google.com/usage into an ISO 8601 string.
 * Supports:
 * - "17:27" -> Today (or tomorrow) at 17:27 local time
 * - "11 Aug at 16:27" or "11 Aug 16:27" -> ISO timestamp for 11 Aug 16:27
 */
export function parseResetsAtToISO(rawReset: string | null | undefined, nowMs: number = Date.now()): string | null {
  if (!rawReset) return null;
  const trimmed = rawReset.trim();

  // Pattern 1: HH:MM (e.g. "17:27")
  const hhmmMatch = trimmed.match(/^([0-9]{1,2}):([0-9]{2})$/);
  if (hhmmMatch) {
    const hours = parseInt(hhmmMatch[1], 10);
    const mins = parseInt(hhmmMatch[2], 10);
    const d = new Date(nowMs);
    d.setHours(hours, mins, 0, 0);
    if (d.getTime() < nowMs - 60_000) {
      d.setDate(d.getDate() + 1);
    }
    return d.toISOString();
  }

  // Pattern 2: "D MMM at HH:MM" or "D MMM HH:MM" (e.g. "11 Aug at 16:27")
  const dateMatch = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)(?:\s+at)?\s+(\d{1,2}):(\d{2})/i);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const monthStr = dateMatch[2];
    const hours = parseInt(dateMatch[3], 10);
    const mins = parseInt(dateMatch[4], 10);
    const year = new Date(nowMs).getFullYear();

    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[monthStr.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const d = new Date(year, month, day, hours, mins, 0, 0);
      if (d.getTime() < nowMs - 86_400_000) {
        d.setFullYear(year + 1);
      }
      return d.toISOString();
    }
  }

  // If already ISO string or parseable by Date constructor
  const parsedDate = new Date(trimmed);
  if (!isNaN(parsedDate.getTime())) {
    return parsedDate.toISOString();
  }

  return null;
}

/**
 * Parse the HTML or embedded JSON data from `https://gemini.google.com/usage`.
 *
 * Extracts:
 * - Current usage (5-hour window): percentage used (0-100) + reset time
 * - Weekly limit (7-day window): percentage used (0-100) + reset time
 */
export function parseGeminiWebUsageHtml(html: string, nowMs: number = Date.now()): GeminiWebUsageSnapshot | null {
  if (!html || (!html.includes("Usage limits") && !html.includes("Current usage"))) {
    return null;
  }

  // 1. Current usage (5-hour window)
  // Handles both DOM orderings: "Current usage ... 1% used ... Resets at 17:27"
  // and "Current usage ... Resets at 17:27 ... 1% used"
  let sessionPercent: number | null = null;
  let sessionResetsAtRaw: string | null = null;

  const sessionMatchA = html.match(
    /Current usage[\s\S]*?(\d+)%\s*used[\s\S]*?Resets\s*at\s*([0-9]{1,2}:[0-9]{2})/i,
  );
  const sessionMatchB = html.match(
    /Current usage[\s\S]*?Resets\s*at\s*([0-9]{1,2}:[0-9]{2})[\s\S]*?(\d+)%\s*used/i,
  );

  if (sessionMatchA) {
    sessionPercent = parseInt(sessionMatchA[1], 10);
    sessionResetsAtRaw = sessionMatchA[2];
  } else if (sessionMatchB) {
    sessionResetsAtRaw = sessionMatchB[1];
    sessionPercent = parseInt(sessionMatchB[2], 10);
  } else {
    const curPctMatch = html.match(/Current usage[\s\S]*?(\d+)%\s*used/i);
    if (curPctMatch) {
      sessionPercent = parseInt(curPctMatch[1], 10);
    }
  }

  // 2. Weekly limit (7-day window)
  // Handles both DOM orderings: "Weekly limit ... Resets on 11 Aug at 16:27 ... 0% used"
  // and "Weekly limit ... 0% used ... Resets on 11 Aug at 16:27"
  let weeklyPercent: number | null = null;
  let weeklyResetsAtRaw: string | null = null;

  const weeklyMatchA = html.match(
    /Weekly limit[\s\S]*?Resets\s*(?:on|at)\s*([0-9A-Za-z\s:]+?)[\s\S]*?(\d+)%\s*used/i,
  );
  const weeklyMatchB = html.match(
    /Weekly limit[\s\S]*?(\d+)%\s*used[\s\S]*?Resets\s*(?:on|at)\s*([^<"\n]+)/i,
  );

  if (weeklyMatchA) {
    weeklyResetsAtRaw = weeklyMatchA[1].trim();
    weeklyPercent = parseInt(weeklyMatchA[2], 10);
  } else if (weeklyMatchB) {
    weeklyPercent = parseInt(weeklyMatchB[1], 10);
    weeklyResetsAtRaw = weeklyMatchB[2].trim();
  } else {
    const wPctMatch = html.match(/Weekly limit[\s\S]*?(\d+)%\s*used/i);
    if (wPctMatch) {
      weeklyPercent = parseInt(wPctMatch[1], 10);
    }
  }

  if (sessionPercent === null && weeklyPercent === null) {
    return null;
  }

  const sessionResetsAt = parseResetsAtToISO(sessionResetsAtRaw, nowMs);
  const weeklyResetsAt = parseResetsAtToISO(weeklyResetsAtRaw, nowMs);

  const limits: UsageLimit[] = [];

  if (sessionPercent !== null) {
    limits.push({
      key: "current_usage",
      label: "Current usage",
      group: "session",
      percent: sessionPercent,
      resets_at: sessionResetsAt,
      severity: null,
    });
  }

  if (weeklyPercent !== null) {
    limits.push({
      key: "weekly_limit",
      label: "Weekly limit",
      group: "weekly",
      percent: weeklyPercent,
      resets_at: weeklyResetsAt,
      severity: null,
    });
  }

  return {
    five_hour:
      sessionPercent !== null
        ? { utilization: sessionPercent, resets_at: sessionResetsAt }
        : null,
    seven_day:
      weeklyPercent !== null
        ? { utilization: weeklyPercent, resets_at: weeklyResetsAt }
        : null,
    limits,
  };
}
