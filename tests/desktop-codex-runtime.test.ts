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
import {
  codexCredentialIdentityKey,
  readCodexAuthFile,
  writeCodexAuthFile,
} from "../desktop/src/codex-switch";

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

  it("names the signed-in seat and refuses a switch with no default profile", async () => {
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
    // No seat has a credential on disk here, so there is nothing to swap in.
    expect(status.switchSupported).toBe(false);
    expect(status.message).toMatch(/signed in as Codex \(Member\)/);

    // These profiles are all keyed — without a default profile there is no
    // path Codex actually reads, so a switch must decline rather than guess.
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


describe("CodexRuntimeManager switch", () => {
  it("swaps the target seat into the default profile and preserves the outgoing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duitsini-codex-switch-mgr-"));
    dirs.push(dir);
    const store = new Store(join(dir, "desktop-state.json"));
    await store.load();

    const defaultHome = join(dir, ".codex");
    const businessHome = join(dir, "seats", "codex_business");
    const memberHome = join(dir, "seats", "codex_member");
    const profiles = [
      { accountKey: "", slot: "member" as const, label: "Codex (current local profile)", codexHome: defaultHome, includeKeychain: true },
      { accountKey: "codex_business", slot: "business" as const, label: "Codex (Business)", codexHome: businessHome, includeKeychain: false },
      { accountKey: "codex_member", slot: "member" as const, label: "Codex (Member)", codexHome: memberHome, includeKeychain: false },
    ];

    const auth = (token: string, email: string) => ({
      auth_mode: "chatgpt",
      email,
      tokens: { access_token: token, account_id: "shared-workspace" },
    });

    // Business exists ONLY in the shared default profile — the case where a
    // careless swap would destroy it.
    await writeCodexAuthFile(defaultHome, auth("business-token", "perminggwee@gmail.com"));
    await writeCodexAuthFile(memberHome, auth("member-token", "leeahming199@gmail.com"));
    for (const [accountKey, slot, label, email] of [
      ["codex_business", "business", "Codex (Business)", "perminggwee@gmail.com"],
      ["codex_member", "member", "Codex (Member)", "leeahming199@gmail.com"],
    ] as const) {
      store.setCodexAccount({ accountKey, slot, label, email, memberId: null, workspaceId: null, workspaceName: null, planType: null, status: "connected" });
    }

    let refreshed = 0;
    const manager = new CodexRuntimeManager(
      profiles,
      store,
      "device-1",
      [{ label: join(defaultHome, "auth.json"), read: async () => readCodexAuthFile(defaultHome) }],
      undefined,
      undefined,
      () => { refreshed += 1; },
    );

    expect((await manager.status()).switchSupported).toBe(true);

    const result = await manager.switchAccount({ accountKey: "codex_member", requestId: "request-abcd1234" });
    expect(result).toMatchObject({ ok: true, code: "switched" });
    expect(result.ok && result.message).toMatch(/Restart Codex/);
    // Usage for both seats must be re-read, not served from the stale cache.
    expect(refreshed).toBe(1);

    expect(codexCredentialIdentityKey(await readCodexAuthFile(defaultHome))).toBe(
      codexCredentialIdentityKey(auth("member-token", "leeahming199@gmail.com")),
    );
    expect(codexCredentialIdentityKey(await readCodexAuthFile(businessHome))).toBe(
      codexCredentialIdentityKey(auth("business-token", "perminggwee@gmail.com")),
    );

    // Repeating the switch is a no-op rather than a second destructive write.
    const again = await manager.switchAccount({ accountKey: "codex_member", requestId: "request-efgh5678" });
    expect(again).toMatchObject({ ok: true, code: "already_active" });
    expect(refreshed).toBe(1);
  });
});

describe("credential file vs app-server precedence", () => {
  const idToken = (email: string) =>
    `header.${Buffer.from(JSON.stringify({ email, sub: `sub-${email}` })).toString("base64url")}.sig`;

  it("trusts the swapped credential over a Codex session that predates the switch", async () => {
    // Field case 2026-09-13: the swap put Member into ~/.codex, but the still
    // running Codex answered "Business", and the dashboard believed it — so it
    // insisted the old seat was active right after switching away from it.
    const dir = await mkdtemp(join(tmpdir(), "duitsini-codex-precedence-"));
    dirs.push(dir);
    const store = new Store(join(dir, "desktop-state.json"));
    await store.load();
    const business = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "business")!;
    const member = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!;
    const defaultHome = join(dir, ".codex");

    const source: CodexCredentialSource = {
      label: join(defaultHome, "auth.json"),
      read: async () => ({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "member-token",
          account_id: "274586c5",
          id_token: idToken("leeahming199@gmail.com"),
        },
      }),
    };
    const profiles = [
      { accountKey: "", slot: "member" as const, label: "Codex (current local profile)", codexHome: defaultHome, includeKeychain: true },
      profile(business.account_key, "business", business.label),
      profile(member.account_key, "member", member.label),
    ];
    // The stale session still claims the account we just switched away from.
    const staleReader = async () => ({
      memberId: null,
      email: "perminggwee@gmail.com",
      workspaceId: null,
      workspaceName: null,
      planType: "team",
    });

    const manager = new CodexRuntimeManager(profiles, store, "device-1", [source], undefined, staleReader);
    for (const [accountKey, slot, label, email] of [
      [business.account_key, "business", business.label, "perminggwee@gmail.com"],
      [member.account_key, "member", member.label, "leeahming199@gmail.com"],
    ] as const) {
      store.setCodexAccount({ accountKey, slot, label, email, memberId: null, workspaceId: null, workspaceName: null, planType: null, status: "connected" });
    }

    const status = await manager.status();
    expect(status.email).toBe("leeahming199@gmail.com");
    expect(status.accountKey).toBe(member.account_key);
    expect(status.message).toMatch(/signed in as Codex \(Member\)/);
  });

  it("still lets the app-server name an identity-free legacy credential", async () => {
    const dir = await mkdtemp(join(tmpdir(), "duitsini-codex-gapfill-"));
    dirs.push(dir);
    const store = new Store(join(dir, "desktop-state.json"));
    await store.load();
    const defaultHome = join(dir, ".codex");
    const source: CodexCredentialSource = {
      label: join(defaultHome, "auth.json"),
      // Desktop <= 1.5.0 wrote credentials carrying no identity at all.
      read: async () => ({ auth_mode: "chatgpt", tokens: { access_token: "legacy", account_id: "274586c5" } }),
    };
    const manager = new CodexRuntimeManager(
      [{ accountKey: "", slot: "member", label: "Codex (current local profile)", codexHome: defaultHome, includeKeychain: true }],
      store,
      "device-1",
      [source],
      undefined,
      async () => ({ memberId: null, email: "perminggwee@gmail.com", workspaceId: null, workspaceName: null, planType: "team" }),
    );

    expect((await manager.status()).email).toBe("perminggwee@gmail.com");
  });
});
