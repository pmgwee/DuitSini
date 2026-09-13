import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexAuthPath,
  codexCredentialIdentityKey,
  readCodexAuthFile,
  previousSignInHome,
  switchCodexAccount,
  writeCodexAuthFile,
} from "../desktop/src/codex-switch";
import type { CodexAccountProfile } from "../desktop/src/collectors/codex";

function credential(accessToken: string, accountId = "acct-274586c5", email = "seat@example.com") {
  // `sub` is where parseCodexIdentity finds the subject on a real auth.json.
  const claims = Buffer.from(JSON.stringify({ email, sub: `sub-${accessToken}` })).toString("base64url");
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      account_id: accountId,
      id_token: `header.${claims}.signature`,
      refresh_token: `refresh-${accessToken}`,
    },
    last_refresh: "2026-09-13T00:00:00.000Z",
  };
}

let root: string;
let defaultProfile: CodexAccountProfile;
let business: CodexAccountProfile;
let member: CodexAccountProfile;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "duitsini-codex-switch-"));
  defaultProfile = { accountKey: "", slot: "member", label: "Codex (current local profile)", codexHome: join(root, ".codex"), includeKeychain: true };
  business = { accountKey: "acct_business", slot: "business", label: "Codex (Business)", codexHome: join(root, "seats", "acct_business") };
  member = { accountKey: "acct_member", slot: "member", label: "Codex (Member)", codexHome: join(root, "seats", "acct_member") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ownerByEmail = (map: Record<string, string>) => (identity: { email: string | null }) =>
  identity.email ? map[identity.email] ?? null : null;

describe("switchCodexAccount", () => {
  it("preserves a seat that lived only in the shared default profile", async () => {
    // This is the destructive case: Business has never been enrolled into its
    // own directory, so a naive swap would erase it and force a re-login.
    await writeCodexAuthFile(defaultProfile.codexHome, credential("business-token", "acct-1", "business@example.com"));
    await writeCodexAuthFile(member.codexHome, credential("member-token", "acct-1", "member@example.com"));

    const outcome = await switchCodexAccount({
      defaultProfile,
      target: member,
      seats: [business, member],
      ownerOf: ownerByEmail({ "business@example.com": "acct_business" }),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.code).toBe("switched");
    expect(outcome.ok && outcome.code === "switched" && outcome.preservedTo).toBe("Codex (Business)");

    // Default now holds Member, and Business survived in its own seat.
    const active = await readCodexAuthFile(defaultProfile.codexHome);
    expect(codexCredentialIdentityKey(active)).toBe(
      codexCredentialIdentityKey(credential("member-token", "acct-1", "member@example.com")),
    );
    const saved = await readCodexAuthFile(business.codexHome);
    expect(codexCredentialIdentityKey(saved)).toBe(
      codexCredentialIdentityKey(credential("business-token", "acct-1", "business@example.com")),
    );
  });

  it("keeps an unrecognised sign-in instead of discarding it", async () => {
    await writeCodexAuthFile(defaultProfile.codexHome, credential("stranger-token", "acct-9", "stranger@example.com"));
    await writeCodexAuthFile(member.codexHome, credential("member-token"));

    const outcome = await switchCodexAccount({
      defaultProfile,
      target: member,
      seats: [business, member],
      ownerOf: () => null,
    });

    expect(outcome.ok).toBe(true);
    const rescued = await readCodexAuthFile(join(root, "seats", "_previous-signin"));
    expect(codexCredentialIdentityKey(rescued)).toBe(
      codexCredentialIdentityKey(credential("stranger-token", "acct-9", "stranger@example.com")),
    );
  });

  it("does not rewrite anything when the target is already active", async () => {
    const shared = credential("member-token");
    await writeCodexAuthFile(defaultProfile.codexHome, shared);
    await writeCodexAuthFile(member.codexHome, shared);
    const before = await readFile(codexAuthPath(defaultProfile.codexHome), "utf8");

    const outcome = await switchCodexAccount({
      defaultProfile,
      target: member,
      seats: [business, member],
      ownerOf: () => "acct_member",
    });

    expect(outcome.ok && outcome.code).toBe("already_active");
    expect(await readFile(codexAuthPath(defaultProfile.codexHome), "utf8")).toBe(before);
  });

  it("refuses a seat that has no stored sign-in and leaves the active one alone", async () => {
    const active = credential("business-token", "acct-1", "business@example.com");
    await writeCodexAuthFile(defaultProfile.codexHome, active);
    await mkdir(member.codexHome, { recursive: true });

    const outcome = await switchCodexAccount({
      defaultProfile,
      target: member,
      seats: [business, member],
      ownerOf: () => "acct_business",
    });

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe("needs_sign_in");
    expect(codexCredentialIdentityKey(await readCodexAuthFile(defaultProfile.codexHome))).toBe(
      codexCredentialIdentityKey(active),
    );
  });

  it("skips the redundant copy when the outgoing seat is already stored", async () => {
    const businessCred = credential("business-token", "acct-1", "business@example.com");
    await writeCodexAuthFile(defaultProfile.codexHome, businessCred);
    await writeCodexAuthFile(business.codexHome, businessCred);
    await writeCodexAuthFile(member.codexHome, credential("member-token"));

    const outcome = await switchCodexAccount({
      defaultProfile,
      target: member,
      seats: [business, member],
      ownerOf: ownerByEmail({ "business@example.com": "acct_business" }),
    });

    expect(outcome.ok && outcome.code === "switched" && outcome.preservedTo).toBeNull();
    expect(codexCredentialIdentityKey(await readCodexAuthFile(business.codexHome))).toBe(
      codexCredentialIdentityKey(businessCred),
    );
  });

  it("treats the same login in two profiles as one identity", async () => {
    // Path-independent: codexCredentialFingerprint folds the path in, which is
    // right for rotation detection and wrong for "is this the same account".
    const shared = credential("same-token");
    await writeCodexAuthFile(defaultProfile.codexHome, shared);
    await writeCodexAuthFile(member.codexHome, shared);
    expect(codexCredentialIdentityKey(await readCodexAuthFile(defaultProfile.codexHome))).toBe(
      codexCredentialIdentityKey(await readCodexAuthFile(member.codexHome)),
    );
  });

  it("ignores a corrupt auth.json rather than throwing", async () => {
    await mkdir(defaultProfile.codexHome, { recursive: true });
    await writeFile(codexAuthPath(defaultProfile.codexHome), "{ not json", "utf8");
    expect(await readCodexAuthFile(defaultProfile.codexHome)).toBeNull();
    expect(codexCredentialIdentityKey(null)).toBeNull();
  });
});

describe("previousSignInHome", () => {
  it("parks a rescued credential beside the seats, not in the home folder", () => {
    expect(previousSignInHome(defaultProfile, [business, member])).toBe(
      join(root, "seats", "_previous-signin"),
    );
  });
});
