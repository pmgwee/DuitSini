/**
 * Account identity helpers for the Codex usage surface.
 *
 * An account key is an opaque, owner-scoped identifier. It is deliberately
 * separate from a provider source, email address, workspace id, or access-token
 * fingerprint: two Business seats can share a workspace/account id and tokens
 * rotate during a normal session.
 */

export type CodexAccountSlot = "business" | "member";

export interface CodexAccountMetadata {
  account_key: string;
  slot: CodexAccountSlot;
  label: string;
  email: string | null;
  member_id?: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  plan_type: string | null;
  connected: boolean;
  verified: boolean;
  status: "connected" | "needs_sign_in" | "unsupported" | "offline";
  device_id?: string | null;
  last_seen_at?: string | null;
}

/**
 * Labels are product copy. Email and provider identity are supplied by the
 * per-owner enrollment record and are intentionally absent from this catalog.
 */
export const CODEX_ACCOUNT_SLOTS: ReadonlyArray<
  Pick<CodexAccountMetadata, "account_key" | "slot" | "label">
> = [
  { account_key: "acct_7f8c3b2a1d4e5f60718293a4b5c6d7e8", slot: "business", label: "Codex (Business)" },
  { account_key: "acct_0e9d8c7b6a5f43210fedcba987654321", slot: "member", label: "Codex (Member)" },
];

export function codexStreamKey(source: string, accountKey?: string | null): string {
  const sourcePart = source.trim();
  const accountPart = accountKey?.trim();
  return accountPart ? sourcePart + ":" + accountPart : sourcePart;
}

export function usageStreamKey(stream: {
  source: string;
  account_key?: string | null;
}): string {
  return codexStreamKey(stream.source, stream.account_key);
}

export function isCodexAccountSlot(value: unknown): value is CodexAccountSlot {
  return value === "business" || value === "member";
}

export function accountSlotForKey(accountKey: string): CodexAccountSlot | null {
  return CODEX_ACCOUNT_SLOTS.find((slot) => slot.account_key === accountKey)?.slot ?? null;
}

export function accountLabelForKey(accountKey: string): string | null {
  return CODEX_ACCOUNT_SLOTS.find((slot) => slot.account_key === accountKey)?.label ?? null;
}

export function sortCodexAccounts(
  accounts: readonly CodexAccountMetadata[],
): CodexAccountMetadata[] {
  const order = new Map(CODEX_ACCOUNT_SLOTS.map((slot, index) => [slot.account_key, index]));
  return [...accounts].sort(
    (a, b) =>
      (order.get(a.account_key) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.account_key) ?? Number.MAX_SAFE_INTEGER) ||
      a.label.localeCompare(b.label),
  );
}
