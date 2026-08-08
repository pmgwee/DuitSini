import type { UsageLimit, UsageWindow } from "./protocol";

export interface GeminiWebUsageSnapshot {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  limits: UsageLimit[];
}

/**
 * Parse the HTML or embedded JSON data from `https://gemini.google.com/usage`.
 *
 * Extracts:
 * - Current usage (5-hour window): percentage used (0-100) + reset time
 * - Weekly limit (7-day window): percentage used (0-100) + reset time
 */
export function parseGeminiWebUsageHtml(html: string): GeminiWebUsageSnapshot | null {
  if (!html || !html.includes("Usage limits")) {
    return null;
  }

  // 1. Current usage (5-hour window)
  // Pattern: "Current usage" ... "X% used" ... "Resets at HH:MM"
  let sessionPercent: number | null = null;
  let sessionResetsAt: string | null = null;

  const sessionMatch = html.match(
    /Current usage[\s\S]*?(\d+)%\s*used[\s\S]*?Resets\s*at\s*([0-9]{1,2}:[0-9]{2})/i,
  );
  if (sessionMatch) {
    sessionPercent = parseInt(sessionMatch[1], 10);
    sessionResetsAt = sessionMatch[2];
  } else {
    // Fallback: simple match for Current usage percentage
    const curPctMatch = html.match(/Current usage[\s\S]*?(\d+)%\s*used/i);
    if (curPctMatch) {
      sessionPercent = parseInt(curPctMatch[1], 10);
    }
  }

  // 2. Weekly limit (7-day window)
  // Pattern: "Weekly limit" ... "X% used" ... "Resets on [Date] at HH:MM"
  let weeklyPercent: number | null = null;
  let weeklyResetsAt: string | null = null;

  const weeklyMatch = html.match(
    /Weekly limit[\s\S]*?(\d+)%\s*used[\s\S]*?Resets\s*(?:on|at)\s*([^<"\n]+)/i,
  );
  if (weeklyMatch) {
    weeklyPercent = parseInt(weeklyMatch[1], 10);
    weeklyResetsAt = weeklyMatch[2].trim();
  } else {
    const wPctMatch = html.match(/Weekly limit[\s\S]*?(\d+)%\s*used/i);
    if (wPctMatch) {
      weeklyPercent = parseInt(wPctMatch[1], 10);
    }
  }

  if (sessionPercent === null && weeklyPercent === null) {
    return null;
  }

  const limits: UsageLimit[] = [];

  if (sessionPercent !== null) {
    limits.push({
      key: "session",
      label: "Current usage",
      group: "session",
      percent: sessionPercent,
      resets_at: sessionResetsAt,
      severity: null,
    });
  }

  if (weeklyPercent !== null) {
    limits.push({
      key: "weekly_all",
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
