import { describe, expect, it } from "vitest";
import { usageStatePresentation } from "./state-presentation";

describe("usageStatePresentation", () => {
  it("distinguishes stale auth, provider cooldown, and offline continuity", () => {
    expect(usageStatePresentation("auth_stale")?.label).toBe("Sign-in stale");
    expect(usageStatePresentation("rate_limited")?.label).toBe("Cooling down");
    expect(usageStatePresentation("offline")?.label).toBe("Saved");
  });

  it("does not badge a live provider", () => {
    expect(usageStatePresentation("live")).toBeNull();
  });
});
