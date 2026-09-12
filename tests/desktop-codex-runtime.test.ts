import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexCredentialFingerprint, type CodexCredentialSource } from "../desktop/src/collectors/codex";
import { CodexRuntimeManager } from "../desktop/src/codex-runtime";
import { Store } from "../desktop/src/store";
import type { UsageStream } from "../desktop/src/types";
import { CODEX_ACCOUNT_SLOTS } from "../lib/claude-usage/codex-accounts";
import { codexAccountProfiles } from "../desktop/src/codex-profiles";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const profile = (accountKey: string, slot: "business" | "member", label: string) => ({
  accountKey,
  slot,
  label,
  codexHome: `/isolated/${accountKey}`,
  includeKeychain: false,
});

describe("Codex account-scoped desktop state", () => {
  it("keeps same-workspace member streams separate across a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duitsini-codex-state-"));
    dirs.push(dir);
    const store = new Store(join(dir, "desktop-state.json"));
    await store.load();
    const business: UsageStream = { source: "codex", account_key: "codex_business", label: "Codex (Business)", five_hour: null, seven_day: null };
    const member: UsageStream = { source: "codex", account_key: "codex_member", label: "Codex (Member)", five_hour: null, seven_day: null };
    store.setSnapshot("codex", business, 10);
    store.setSnapshot("codex", member, 20);
    await store.save();

    const restarted = new Store(join(dir, "desktop-state.json"));
    await restarted.load();
    expect(restarted.snapshot("codex", "codex_business")?.stream.account_key).toBe("codex_business");
    expect(restarted.snapshot("codex", "codex_member")?.stream.account_key).toBe("codex_member");
    expect(Object.keys(restarted.get().snapshots ?? {}).filter((key) => key.startsWith("codex:")).sort()).toEqual([
      "codex:codex_business",
      "codex:codex_member",
    ]);
  });
});

describe("CodexRuntimeManager", () => {
  it("keeps the current Codex profile observational and enrolls both seats in isolated homes", () => {
    const profiles = codexAccountProfiles("C:\\DuitSini");
    const current = profiles.find((candidate) => candidate.accountKey === "");
    const enrolled = profiles.filter((candidate) => candidate.accountKey !== "");

    expect(current).toBeDefined();
    expect(enrolled.map((candidate) => candidate.accountKey).sort()).toEqual(
      CODEX_ACCOUNT_SLOTS.map((slot) => slot.account_key).sort(),
    );
    expect(enrolled.every((candidate) => candidate.includeKeychain === false)).toBe(true);
    expect(new Set(enrolled.map((candidate) => candidate.codexHome)).size).toBe(2);
    expect(enrolled.every((candidate) => candidate.codexHome !== current?.codexHome)).toBe(true);
  });

  it("reports credential evidence without claiming GUI control", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duitsini-codex-runtime-"));
    dirs.push(dir);
    const store = new Store(join(dir, "desktop-state.json"));
    await store.load();
    const raw = {
      auth_mode: "chatgpt",
      email: "leeahming199@gmail.com",
      workspace_id: "mingcreatives",
      workspace_name: "mingcreatives",
      tokens: { access_token: "member-token", account_id: "shared-workspace" },
    };
    const source: CodexCredentialSource = { label: "member-auth", read: async () => raw };
    store.setCodexAccount({
      accountKey: "codex_member",
      slot: "member",
      label: "Codex (Member)",
      email: "leeahming199@gmail.com",
      memberId: "member-1",
      workspaceId: "mingcreatives",
      workspaceName: "mingcreatives",
      planType: "business",
      credentialFingerprint: codexCredentialFingerprint("member-auth", "member-token", "shared-workspace"),
      status: "connected",
    });
    const manager = new CodexRuntimeManager(
      [profile("codex_business", "business", "Codex (Business)"), profile("codex_member", "member", "Codex (Member)")],
      store,
      "device-1",
      [source],
    );
    const status = await manager.status();
    expect(status.state).toBe("unknown");
    expect(status.accountKey).toBe("codex_member");
    expect(status.switchSupported).toBe(false);
    expect(status.message).toMatch(/GUI account is not exposed/);

    const result = await manager.switchAccount({ accountKey: "codex_business", requestId: "request-1234", expectedGeneration: 0 });
    expect(result).toMatchObject({ ok: false, code: "unsupported" });
    expect((await manager.status()).accountKey).toBe("codex_member");
  });

  it("uses an injected read-only app-server identity to correct the default profile slot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duitsini-codex-app-server-"));
    dirs.push(dir);
    const store = new Store(join(dir, "desktop-state.json"));
    await store.load();
    const business = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "business")!;
    const member = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!;
    const defaultHome = "C:\\Users\\test\\.codex";
    const raw = {
      auth_mode: "chatgpt",
      tokens: { access_token: "member-profile-token", account_id: "shared-workspace" },
    };
    const source: CodexCredentialSource = {
      label: `${defaultHome}\\auth.json`,
      read: async () => raw,
    };
    const profiles = [
      profile(business.account_key, "business", business.label),
      { ...profile(member.account_key, "member", member.label), codexHome: defaultHome },
    ];
    const readerCalls: string[] = [];
    const reader = async (codexHome: string) => {
      readerCalls.push(codexHome);
      return codexHome === defaultHome
        ? { memberId: null, email: "perminggwee@gmail.com", workspaceId: null, workspaceName: null, planType: "team" }
        : null;
    };
    const manager = new CodexRuntimeManager(profiles, store, "device-1", [source], undefined, reader);
    manager.syncAccounts([
      {
        ...business,
        email: "perminggwee@gmail.com",
        workspace_id: null,
        workspace_name: null,
        plan_type: "team",
        connected: false,
        verified: false,
        status: "needs_sign_in",
      },
      {
        ...member,
        email: "leeahming199@gmail.com",
        workspace_id: null,
        workspace_name: null,
        plan_type: "team",
        connected: false,
        verified: false,
        status: "needs_sign_in",
      },
    ]);

    const status = await manager.status();
    expect(readerCalls).toEqual([defaultHome]);
    expect(status).toMatchObject({
      state: "unknown",
      accountKey: business.account_key,
      label: business.label,
      email: "perminggwee@gmail.com",
      planType: "team",
      switchSupported: false,
    });
  });
});

