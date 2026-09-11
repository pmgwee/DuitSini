import { describe, expect, it } from "vitest";
import { CODEX_ACCOUNT_SLOTS, sortCodexAccounts, usageStreamKey } from "./codex-accounts";

describe("Codex account identity", () => {
  it("uses the provider plus opaque account key as the shared stream key", () => {
    expect(usageStreamKey({ source: "codex", account_key: "codex_business" })).toBe("codex:codex_business");
    expect(usageStreamKey({ source: "codex" })).toBe("codex");
  });

  it("keeps Business before Member regardless of ingest order", () => {
    const accounts = CODEX_ACCOUNT_SLOTS.map((slot) => ({
      ...slot,
      email: null,
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: false,
      verified: false,
      status: "offline" as const,
    })).reverse();
    expect(sortCodexAccounts(accounts).map((account) => account.label)).toEqual([
      "Codex (Business)",
      "Codex (Member)",
    ]);
  });
});

