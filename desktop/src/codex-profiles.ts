import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_ACCOUNT_SLOTS } from "../../lib/claude-usage/codex-accounts";
import type { CodexAccountProfile } from "./collectors/codex";

/**
 * Deterministic local profile locations. The installed Codex default is read
 * as an unassigned observer and attributed only after provider identity is
 * validated. Each enrolled seat also owns an isolated home, so connecting one
 * seat cannot replace the default GUI credential or the other seat's token.
 * Profile paths never leave the Desktop main process.
 */
export function codexAccountProfiles(userDataDir: string): CodexAccountProfile[] {
  const member = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!;
  const business = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "business")!;
  const defaultHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const businessHome =
    process.env.DUITSINI_CODEX_BUSINESS_HOME || join(userDataDir, "codex-accounts", business.account_key);
  const memberHome =
    process.env.DUITSINI_CODEX_MEMBER_HOME || join(userDataDir, "codex-accounts", member.account_key);
  return [
    {
      accountKey: "",
      slot: "member",
      label: "Codex (current local profile)",
      codexHome: defaultHome,
      includeKeychain: true,
    },
    {
      accountKey: business.account_key,
      slot: business.slot,
      label: business.label,
      codexHome: businessHome,
      includeKeychain: false,
    },
    {
      accountKey: member.account_key,
      slot: member.slot,
      label: member.label,
      codexHome: memberHome,
      includeKeychain: false,
    },
  ];
}

