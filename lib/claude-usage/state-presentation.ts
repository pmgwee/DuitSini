import type { UsageStream } from "./protocol";

export interface UsageStatePresentation {
  label: string;
  tone: "warning" | "muted";
  fallbackDescription: string;
}

export function usageStatePresentation(
  state: UsageStream["state"] | undefined,
): UsageStatePresentation | null {
  switch (state) {
    case "auth_stale":
      return {
        label: "Sign-in stale",
        tone: "warning",
        fallbackDescription: "Automatic sign-in renewal is waiting; showing the last exact reading.",
      };
    case "rate_limited":
      return {
        label: "Cooling down",
        tone: "warning",
        fallbackDescription: "The provider asked DuitSini to wait; showing the last exact reading.",
      };
    case "offline":
      return {
        label: "Saved",
        tone: "muted",
        fallbackDescription: "The provider is temporarily unavailable; showing the last exact reading.",
      };
    case "cached":
      return {
        label: "Saved",
        tone: "muted",
        fallbackDescription: "Showing the most recent successful reading.",
      };
    default:
      return null;
  }
}
