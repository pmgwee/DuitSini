import { describe, expect, it } from "vitest";
import {
  CODEX_ACCOUNT_SLOTS,
  accountForCodexStream,
  mergeCodexAccountMetadata,
  sortCodexAccounts,
  usageStreamKey,
  withoutCodexStreams,
} from "./codex-accounts";

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

  it("uses stable identity to correct a stream emitted under the wrong profile slot", () => {
    const accounts = CODEX_ACCOUNT_SLOTS.map((slot) => ({
      ...slot,
      email: slot.slot === "business" ? "perminggwee@gmail.com" : "leeahming199@gmail.com",
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: true,
      verified: true,
      status: "connected" as const,
    }));

    expect(
      accountForCodexStream(
        {
          source: "codex",
          // The default local profile was historically labeled Member, but
          // the provider identity says this is the Business seat.
          account_key: CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")?.account_key,
          account_email: "perminggwee@gmail.com",
        },
        accounts,
      )?.slot,
    ).toBe("business");
  });

  it("attributes an anonymous legacy Codex stream when its enrolled email is present", () => {
    const accounts = CODEX_ACCOUNT_SLOTS.map((slot) => ({
      ...slot,
      email: slot.slot === "business" ? "perminggwee@gmail.com" : "leeahming199@gmail.com",
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: false,
      verified: false,
      status: "needs_sign_in" as const,
    }));

    expect(
      accountForCodexStream({ source: "codex", account_email: "perminggwee@gmail.com" }, accounts)?.slot,
    ).toBe("business");
  });

  it("does not guess an account for an identity-free legacy stream", () => {
    const accounts = CODEX_ACCOUNT_SLOTS.map((slot) => ({
      ...slot,
      email: null,
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: false,
      verified: false,
      status: "needs_sign_in" as const,
    }));

    expect(accountForCodexStream({ source: "codex" }, accounts)).toBeNull();
  });

  it("keeps enrolled email when a persisted account row has not learned identity", () => {
    const fallback = {
      ...CODEX_ACCOUNT_SLOTS[0],
      email: "perminggwee@gmail.com",
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: false,
      verified: false,
      status: "needs_sign_in" as const,
    };
    const observed = { ...fallback, email: null, connected: true, status: "connected" as const };
    expect(mergeCodexAccountMetadata(fallback, observed)).toMatchObject({
      email: "perminggwee@gmail.com",
      connected: true,
      status: "connected",
    });
  });

  it("keeps Codex out of the generic provider stream list", () => {
    const streams = [
      { source: "claude_pro", label: "Claude Pro" },
      { source: "codex", label: "Codex (Business)" },
    ];
    expect(withoutCodexStreams(streams)).toEqual([{ source: "claude_pro", label: "Claude Pro" }]);
  });
});

