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
 * The account key is the preferred identity for current desktop streams, but
 * older profiles could stamp the default local credential with the Member key
 * even when the provider identity was the Business seat. A unique enrolled
 * email is stronger evidence and corrects that historical profile attribution.
 * Identity-free legacy streams remain unresolved rather than being guessed.
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
    if (keyed && emailMatches.includes(keyed)) return keyed;
    return null;
  }

  return keyed;
}

/** The generic usage view is reserved for providers without account cards. */
export function withoutCodexStreams<T extends { source: string }>(
  streams: readonly T[],
): T[] {
  return streams.filter((stream) => stream.source !== "codex");
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
