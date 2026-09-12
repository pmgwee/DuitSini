import { describe, expect, it } from "vitest";
import { streamsWithCodexAccounts } from "../features/dashboard/codex-usage-streams";
import { CODEX_ACCOUNT_SLOTS, type CodexAccountMetadata } from "../lib/claude-usage/codex-accounts";
import type { UsageStream } from "../features/dashboard/use-claude-usage-live";

function accounts(): CodexAccountMetadata[] {
  return CODEX_ACCOUNT_SLOTS.map((slot) => ({
    ...slot,
    email: slot.slot === "business" ? "perminggwee@gmail.com" : "leeahming199@gmail.com",
    member_id: slot.slot === "business" ? "business-member" : null,
    workspace_id: null,
    workspace_name: null,
    plan_type: "team",
    connected: slot.slot === "business",
    verified: false,
    status: slot.slot === "business" ? "connected" : "needs_sign_in",
  }));
}

describe("Codex account usage sections", () => {
  it("keeps the original ring stream and produces Business then Member", () => {
    const memberKey = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!.account_key;
    const streams: UsageStream[] = [
      { source: "claude_pro", label: "Claude Pro", five_hour: null, seven_day: null },
      {
        source: "codex",
        label: "Codex (Member)",
        account_key: memberKey,
        member_id: "business-member",
        five_hour: { utilization: 71, resets_at: null },
        seven_day: { utilization: 27, resets_at: null },
      },
    ];

    const result = streamsWithCodexAccounts(streams, accounts());
    const codex = result.filter((stream) => stream.source === "codex");
    expect(result[0].label).toBe("Claude Pro");
    expect(codex.map((stream) => stream.label)).toEqual(["Codex (Business)", "Codex (Member)"]);
    expect(codex[0].five_hour?.utilization).toBe(71);
    expect(codex[1].five_hour).toEqual({ utilization: null, resets_at: null });
  });

  it("does not flash a legacy Member assignment before owner metadata loads", () => {
    const memberKey = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!.account_key;
    const result = streamsWithCodexAccounts(
      [{ source: "codex", label: "Codex (Member)", account_key: memberKey, five_hour: { utilization: 71, resets_at: null } }],
      accounts(),
      false,
    );

    expect(result.filter((stream) => stream.source === "codex").map((stream) => stream.five_hour?.utilization)).toEqual([null, null]);
  });
});

/*
 * End-to-end composition against the exact rows in production on 2026-09-12:
 * the streams_json pushed by the installed Desktop 1.5.0 and the repaired
 * codex_accounts directory for the owner whose dashboard showed the wrong seat.
 */
describe("live owner composition", () => {
  const liveStreams: UsageStream[] = [
    {
      source: "claude_pro",
      label: "Claude Pro",
      state: "live",
      five_hour: { utilization: 2, resets_at: "2026-09-12T10:39:59.638504+00:00" },
      seven_day: { utilization: 6, resets_at: "2026-09-18T08:59:59.638537+00:00" },
    },
    {
      source: "codex",
      label: "Codex (Member)",
      state: "live",
      account_key: "acct_0e9d8c7b6a5f43210fedcba987654321",
      account_email: null,
      member_id: "google-oauth2|101517735124697708653",
      workspace_id: null,
      five_hour: { utilization: 100, resets_at: "2026-09-12T10:42:21.000Z" },
      seven_day: { utilization: 31, resets_at: "2026-09-18T18:06:17.000Z" },
    },
  ];

  const directory: CodexAccountMetadata[] = [
    {
      account_key: "acct_7f8c3b2a1d4e5f60718293a4b5c6d7e8",
      slot: "business",
      label: "Codex (Business)",
      email: "perminggwee@gmail.com",
      member_id: "google-oauth2|101517735124697708653",
      workspace_id: "274586c5-d103-44ca-89bb-ee5aa72008fb",
      workspace_name: null,
      plan_type: "team",
      connected: true,
      verified: false,
      status: "connected",
    },
    {
      account_key: "acct_0e9d8c7b6a5f43210fedcba987654321",
      slot: "member",
      label: "Codex (Member)",
      email: null,
      member_id: null,
      workspace_id: null,
      workspace_name: null,
      plan_type: null,
      connected: false,
      verified: false,
      status: "needs_sign_in",
    },
  ];

  it("routes the live reading to Business and leaves Member awaiting sign-in", () => {
    const sections = streamsWithCodexAccounts(liveStreams, directory);
    const codex = sections.filter((stream) => stream.source === "codex");

    expect(sections.map((stream) => stream.label)).toEqual([
      "Claude Pro",
      "Codex (Business)",
      "Codex (Member)",
    ]);
    expect(codex[0].five_hour?.utilization).toBe(100);
    expect(codex[0].seven_day?.utilization).toBe(31);
    expect(codex[0].account_email).toBe("perminggwee@gmail.com");
    expect(codex[1].five_hour?.utilization).toBeNull();
    expect(codex[1].state).toBe("not_connected");
  });

  it("still renders both seats as sections, so each keeps its own two gauges", () => {
    const codex = streamsWithCodexAccounts(liveStreams, directory).filter((s) => s.source === "codex");
    for (const stream of codex) {
      expect(stream.five_hour).not.toBeUndefined();
      expect(stream.seven_day).not.toBeUndefined();
    }
  });
});
