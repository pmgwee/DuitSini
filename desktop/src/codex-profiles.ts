import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_ACCOUNT_SLOTS } from "../../lib/claude-usage/codex-accounts";
import type { CodexAccountProfile } from "./collectors/codex";

/**
 * Deterministic local profile locations. The Member profile follows the
 * installed Codex default, while Business is enrolled into an isolated home.
 * A profile path is an implementation detail and is never sent to the web
 * application or written to the public desktop state.
 */
export function codexAccountProfiles(userDataDir: string): CodexAccountProfile[] {
  const member = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "member")!;
  const business = CODEX_ACCOUNT_SLOTS.find((slot) => slot.slot === "business")!;
  const memberHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const businessHome =
    process.env.DUITSINI_CODEX_BUSINESS_HOME || join(userDataDir, "codex-accounts", business.account_key);
  return [
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
      includeKeychain: true,
    },
  ];
}

