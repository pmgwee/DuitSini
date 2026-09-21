import { describe, expect, it } from "vitest";
import { findIssuer } from "@/lib/payment-methods";
import { findProviderPreset } from "@/lib/providers";

describe("supported brand catalog", () => {
  it("recognizes OpenRouter and OpenCode with Simple Icons metadata", () => {
    expect(findProviderPreset("OpenRouter")).toMatchObject({
      icon: "openrouter",
      domain: "openrouter.ai",
    });
    expect(findProviderPreset("OpenCode Go")).toMatchObject({
      icon: "opencode",
      domain: "opencode.ai",
    });
  });

  it("recognizes Grok with its official domain favicon fallback", () => {
    expect(findProviderPreset("Grok")).toMatchObject({
      domain: "grok.com",
    });
  });

  it("recognizes Ryt Bank with its official domain favicon fallback", () => {
    expect(findIssuer("ryt_bank")).toMatchObject({
      label: "Ryt Bank",
      domain: "rytbank.my",
    });
  });
});
