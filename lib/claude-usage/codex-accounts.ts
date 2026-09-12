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

export interface CodexStreamIdentity {
  source: string;
  account_key?: string | null;
  account_email?: string | null;
  member_id?: string | null;
  workspace_id?: string | null;
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

function normalizedEmail(value: string | null | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email && email.includes("@") ? email : null;
}

/**
 * Resolve one Codex stream to an enrolled account.
 *
 * The account key is the preferred identity for isolated per-seat profiles,
 * but the default local profile is shared: Desktop <= 1.5.0 stamped it with the
 * Member key no matter which seat was actually signed in. Provider identity is
 * therefore the stronger evidence and is allowed to correct the key.
 *
 * Precedence is "unique match wins, unknown identity abstains":
 *  - an identity that matches exactly one enrolled account resolves to it;
 *  - an ambiguous match (two seats carrying the same identity) keeps the key
 *    when the key is one of them, because a tie proves nothing;
 *  - an identity the directory has never seen neither confirms nor contradicts
 *    the key, so it falls through to the next signal instead of discarding a
 *    live reading. Only a positive contradiction refuses to attribute.
 */
export function accountForCodexStream(
  stream: CodexStreamIdentity,
  accounts: readonly CodexAccountMetadata[],
): CodexAccountMetadata | null {
  if (stream.source !== "codex") return null;

  const keyed = stream.account_key
    ? accounts.find((account) => account.account_key === stream.account_key) ?? null
    : null;

  const email = normalizedEmail(stream.account_email);
  if (email) {
    const emailMatches = accounts.filter((account) => normalizedEmail(account.email) === email);
    if (emailMatches.length === 1) return emailMatches[0];
    if (emailMatches.length > 1) return keyed && emailMatches.includes(keyed) ? keyed : null;
    // Length 0: this sign-in is simply not enrolled yet. Keep looking.
  }

  const memberId = stream.member_id?.trim() || null;
  if (memberId) {
    const memberMatches = accounts.filter((account) => {
      if (account.member_id?.trim() !== memberId) return false;
      return !stream.workspace_id || !account.workspace_id || account.workspace_id === stream.workspace_id;
    });
    if (memberMatches.length === 1) return memberMatches[0];
    if (memberMatches.length > 1) return keyed && memberMatches.includes(keyed) ? keyed : null;
  }

  // A directory that positively binds this email elsewhere must not be
  // overridden by a shared default-profile key.
  if (email && accounts.some((account) => normalizedEmail(account.email) && normalizedEmail(account.email) !== email && account.account_key === keyed?.account_key)) {
    return null;
  }

  return keyed;
}

/** Resolve and deduplicate current/legacy Codex readings by enrolled account. */
export function codexStreamsByAccount<T extends CodexStreamIdentity & { cached?: boolean }>(
  streams: readonly T[],
  accounts: readonly CodexAccountMetadata[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const stream of streams) {
    if (stream.source !== "codex") continue;
    const account = accountForCodexStream(stream, accounts);
    if (!account) continue;
    const previous = result.get(account.account_key);
    if (!previous || (previous.cached && !stream.cached)) {
      result.set(account.account_key, stream);
    }
  }
  return result;
}

/**
 * Keep server-provided fallback identity when a persisted row has not learned
 * that field yet. A null observation must not erase a known enrollment email.
 */
export function mergeCodexAccountMetadata(
  fallback: CodexAccountMetadata,
  observed: CodexAccountMetadata,
): CodexAccountMetadata {
  return {
    ...fallback,
    ...observed,
    email: observed.email ?? fallback.email,
    member_id: observed.member_id ?? fallback.member_id,
    workspace_id: observed.workspace_id ?? fallback.workspace_id,
    workspace_name: observed.workspace_name ?? fallback.workspace_name,
    plan_type: observed.plan_type ?? fallback.plan_type,
    device_id: observed.device_id ?? fallback.device_id,
    last_seen_at: observed.last_seen_at ?? fallback.last_seen_at,
  };
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
