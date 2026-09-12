import { describe, expect, it } from "vitest";
import {
  CODEX_ACCOUNT_SLOTS,
  accountForCodexStream,
  codexStreamsByAccount,
  mergeCodexAccountMetadata,
  sortCodexAccounts,
  usageStreamKey,
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

  it("corrects a Desktop 1.5.0 Member key through an owner-bound legacy member identity", () => {
    const accounts = CODEX_ACCOUNT_SLOTS.map((slot) => ({
      ...slot,
      email: slot.slot === "business" ? "perminggwee@gmail.com" : "leeahming199@gmail.com",
      member_id: slot.slot === "business" ? "legacy-business-subject" : null,
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: slot.slot === "business",
      verified: false,
      status: slot.slot === "business" ? "connected" as const : "needs_sign_in" as const,
    }));
    const memberKey = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!.account_key;
    const businessKey = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "business")!.account_key;
    const stream = {
      source: "codex",
      account_key: memberKey,
      member_id: "legacy-business-subject",
      cached: false,
    };

    expect(accountForCodexStream(stream, accounts)?.slot).toBe("business");
    expect(codexStreamsByAccount([stream], accounts).get(businessKey)).toBe(stream);
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

});


/*
 * Field evidence, 2026-09-12. Desktop 1.5.0 reads the shared default profile
 * (~/.codex) and stamps it with the Member key regardless of which seat is
 * signed in. The only identity it forwards is the OAuth subject.
 */
describe("Desktop 1.5.0 default-profile attribution", () => {
  const LIVE_SUBJECT = "google-oauth2|101517735124697708653";
  const memberKey = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!.account_key;
  const liveStream = {
    source: "codex",
    label: "Codex (Member)",
    account_key: memberKey,
    account_email: null,
    member_id: LIVE_SUBJECT,
    workspace_id: null,
  };

  function directory(businessSubject: string | null, memberSubject: string | null) {
    return CODEX_ACCOUNT_SLOTS.map((slot) => ({
      ...slot,
      email: slot.slot === "business" ? "perminggwee@gmail.com" : null,
      member_id: slot.slot === "business" ? businessSubject : memberSubject,
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: slot.slot === "business",
      verified: false,
      status: slot.slot === "business" ? ("connected" as const) : ("needs_sign_in" as const),
    }));
  }

  it("resolves the live reading to Business once only that seat owns the subject", () => {
    expect(accountForCodexStream(liveStream, directory(LIVE_SUBJECT, null))?.slot).toBe("business");
  });

  it("refuses to claim a seat while both rows carry the same subject", () => {
    // The tie proves nothing, so the Member key must not win by default.
    expect(accountForCodexStream(liveStream, directory(LIVE_SUBJECT, LIVE_SUBJECT))?.slot).toBe("member");
  });

  it("keeps a live reading whose sign-in is not enrolled yet", () => {
    // An unknown email must abstain, not discard the only usage data we have.
    const accounts = directory(null, null);
    const upgraded = { ...liveStream, account_email: "someone-not-enrolled@example.com" };
    expect(accountForCodexStream(upgraded, accounts)?.account_key).toBe(memberKey);
  });

  it("attributes the Desktop 1.5.1 payload by enrolled email", () => {
    // 1.5.1 reads the OpenAI auth claim block, so the subject spelling changes
    // from the OAuth `sub` to `chatgpt_user_id`. Email must carry attribution.
    const upgraded = {
      ...liveStream,
      account_email: "perminggwee@gmail.com",
      member_id: "user-ZYk7Xrez1KhPsChuOcmVihsu",
      workspace_id: "274586c5-d103-44ca-89bb-ee5aa72008fb",
    };
    expect(accountForCodexStream(upgraded, directory(LIVE_SUBJECT, null))?.slot).toBe("business");
  });
});
