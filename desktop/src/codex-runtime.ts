import { parseCodexAuth, parseCodexIdentity, type CodexIdentity } from "../../lib/claude-usage/codex";
import {
  CODEX_ACCOUNT_SLOTS,
  type CodexAccountMetadata,
} from "../../lib/claude-usage/codex-accounts";
import {
  codexCredentialFingerprint,
  codexCredentialSources,
  type CodexCredentialSource,
  type CodexAccountProfile,
} from "./collectors/codex";
import type { CodexAccountReader } from "./codex-app-server";
import type { Store } from "./store";

export type CodexRuntimeState = "detected" | "unknown" | "not_running" | "unsupported";

export interface CodexRuntimeStatus {
  state: CodexRuntimeState;
  accountKey: string | null;
  label: string | null;
  memberId: string | null;
  email: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  planType: string | null;
  deviceId: string;
  observedAt: number;
  generation: number;
  confidence: "credential-file" | "unsupported";
  switchSupported: false;
  message: string;
}

export interface CodexSwitchRequest {
  accountKey: string;
  requestId: string;
  expectedGeneration?: number;
}

export type CodexActionResult =
  | { ok: true; code: "already_active"; status: CodexRuntimeStatus }
  | { ok: true; code: "started"; message: string; status: CodexRuntimeStatus }
  | { ok: false; code: "bad_request" | "busy" | "stale_generation" | "unsupported" | "needs_sign_in"; message: string; status: CodexRuntimeStatus };

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function emptyIdentity(): CodexIdentity {
  return { memberId: null, email: null, workspaceId: null, workspaceName: null, planType: null };
}

/**
 * Read-only observation and capability gate for the installed Codex build.
 * The credential file is useful evidence for quota collection, but it cannot
 * prove which account an already-running GUI has selected. Consequently this
 * manager never edits CODEX_HOME/auth.json and never reports a cosmetic switch
 * as successful.
 */
export class CodexRuntimeManager {
  private locked = false;
  private generation = 0;
  private observedFingerprint: string | null = null;
  private readonly requestResults = new Map<string, CodexActionResult>();
  private current: CodexRuntimeStatus;

  constructor(
    private readonly profiles: readonly CodexAccountProfile[],
    private readonly store: Store,
    private readonly deviceId: string,
    private readonly credentialSources: readonly CodexCredentialSource[] = codexCredentialSources(),
    private readonly startEnrollment?: (profile: CodexAccountProfile) => Promise<{ ok: boolean; message: string }>,
    private readonly accountReader?: CodexAccountReader,
  ) {
    this.current = this.unsupportedStatus("Codex GUI account control is not exposed by this build.");
  }

  /**
   * Sync public enrollment metadata from the signed-in web owner. This gives
   * the local reader a stable email-to-slot map without moving credentials or
   * trusting a renderer supplied token/path.
   */
  syncAccounts(accounts: readonly CodexAccountMetadata[]): void {
    for (const account of accounts) {
      const slot = CODEX_ACCOUNT_SLOTS.find((candidate) => candidate.account_key === account.account_key);
      if (!slot || account.slot !== slot.slot) continue;
      const existing = this.store.codexAccount(account.account_key);
      const parsedLastSeen = account.last_seen_at ? Date.parse(account.last_seen_at) : NaN;
      this.store.setCodexAccount({
        accountKey: slot.account_key,
        slot: slot.slot,
        label: slot.label,
        email: account.email ?? existing?.email ?? null,
        memberId: account.member_id ?? existing?.memberId ?? null,
        workspaceId: account.workspace_id ?? existing?.workspaceId ?? null,
        workspaceName: account.workspace_name ?? existing?.workspaceName ?? null,
        planType: account.plan_type ?? existing?.planType ?? null,
        credentialFingerprint: existing?.credentialFingerprint,
        status: existing?.status === "connected" ? existing.status : account.status,
        lastSeenAt: Number.isFinite(parsedLastSeen) ? parsedLastSeen : existing?.lastSeenAt,
      });
    }
  }

  private readonly appServerCache = new Map<string, { at: number; identity: CodexIdentity | null; inflight?: Promise<CodexIdentity | null> }>();

  private async appServerIdentity(profile: CodexAccountProfile): Promise<CodexIdentity | null> {
    if (!this.accountReader) return null;
    const now = Date.now();
    const current = this.appServerCache.get(profile.codexHome);
    if (current?.inflight) return current.inflight;
    if (current && now - current.at < 5 * 60_000) return current.identity;
    const inflight = this.accountReader(profile.codexHome).catch(() => null).then((identity) => {
      this.appServerCache.set(profile.codexHome, { at: Date.now(), identity });
      return identity;
    });
    this.appServerCache.set(profile.codexHome, { at: now, identity: current?.identity ?? null, inflight });
    try {
      return await inflight;
    } finally {
      const after = this.appServerCache.get(profile.codexHome);
      if (after?.inflight === inflight) this.appServerCache.set(profile.codexHome, { at: Date.now(), identity: after.identity });
    }
  }

  private profileForSource(sourceLabel: string): CodexAccountProfile | null {
    const normalized = sourceLabel.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return this.profiles.find((profile) => {
      const authPath = `${profile.codexHome.replace(/\\/g, "/").replace(/\/+$/, "")}/auth.json`.toLowerCase();
      return normalized === authPath;
    }) ?? null;
  }

  private accountForIdentity(
    identity: CodexIdentity,
    profile: CodexAccountProfile | null,
    fingerprint: string,
  ): CodexAccountProfile | null {
    const accounts = this.store.get().codexAccounts ?? {};
    const email = identity.email?.trim().toLowerCase() ?? null;
    if (email) {
      const emailMatches = this.profiles.filter((candidate) => {
        const account = accounts[candidate.accountKey];
        return account?.email?.trim().toLowerCase() === email;
      });
      if (emailMatches.length === 1) return emailMatches[0];
    }
    const fingerprintMatch = this.profiles.find((candidate) => {
      const account = accounts[candidate.accountKey];
      if (!account || account.credentialFingerprint !== fingerprint) return false;
      if (account.memberId && identity.memberId && account.memberId !== identity.memberId) return false;
      if (account.workspaceId && identity.workspaceId && account.workspaceId !== identity.workspaceId) return false;
      return true;
    });
    return fingerprintMatch ?? profile;
  }

  async observeRuntime(): Promise<CodexRuntimeStatus> {
    const observedAt = Date.now();
    const accounts = this.store.get().codexAccounts ?? {};
    const sources = this.credentialSources;
    let sawCredential = false;
    for (const source of sources) {
      const raw = await source.read();
      const credential = parseCodexAuth(raw);
      if (!credential) continue;
      sawCredential = true;
      const fingerprint = codexCredentialFingerprint(source.label, credential.accessToken, credential.accountId);
      if (this.observedFingerprint !== null && this.observedFingerprint !== fingerprint) this.generation += 1;
      this.observedFingerprint = fingerprint;
      const profile = this.profileForSource(source.label);
      const authIdentity = parseCodexIdentity(raw, credential);
      const serverIdentity = profile ? await this.appServerIdentity(profile) : null;
      const identity: CodexIdentity = {
        memberId: serverIdentity?.memberId ?? authIdentity.memberId,
        email: serverIdentity?.email ?? authIdentity.email,
        workspaceId: serverIdentity?.workspaceId ?? authIdentity.workspaceId,
        workspaceName: serverIdentity?.workspaceName ?? authIdentity.workspaceName,
        planType: serverIdentity?.planType ?? authIdentity.planType,
      };
      const match = this.accountForIdentity(identity, profile, fingerprint);
      const matchedAccount = match ? accounts[match.accountKey] : null;
      /*
       * A credential file path is a profile hint, not an account identity. The
       * app-server account/read result (or token claims) is allowed to move a
       * default profile from Member to Business when the enrolled email proves
       * that mapping. The running GUI remains unverified and uncontrollable.
       */
      this.current = {
        state: "unknown",
        accountKey: match?.accountKey ?? null,
        label: match?.label ?? null,
        memberId: identity.memberId ?? matchedAccount?.memberId ?? null,
        email: identity.email ?? matchedAccount?.email ?? null,
        workspaceId: identity.workspaceId ?? matchedAccount?.workspaceId ?? null,
        workspaceName: identity.workspaceName ?? matchedAccount?.workspaceName ?? null,
        planType: identity.planType ?? matchedAccount?.planType ?? null,
        deviceId: this.deviceId,
        observedAt,
        generation: this.generation,
        confidence: "credential-file",
        switchSupported: false,
        message: match
          ? `Local credentials match ${match.label}; the running Codex GUI account is not exposed by this build.`
          : "A Codex credential was found, but it is not bound to a verified enrolled account.",
      };
      this.store.setCodexRuntime({
        state: this.current.state,
        accountKey: this.current.accountKey,
        memberId: this.current.memberId,
        email: this.current.email,
        workspaceId: this.current.workspaceId,
        workspaceName: this.current.workspaceName,
        observedAt,
        confidence: this.current.confidence,
        message: this.current.message,
      });
      return this.current;
    }
    this.current = this.unsupportedStatus(
      sawCredential
        ? "Codex credentials were found, but the running GUI account cannot be verified."
        : "No Codex credential is available for runtime observation.",
    );
    this.current = { ...this.current, state: sawCredential ? "unknown" : "not_running" };
    this.store.setCodexRuntime({
      state: this.current.state,
      accountKey: null,
      memberId: null,
      email: null,
      workspaceId: null,
      workspaceName: null,
      observedAt,
      confidence: "unsupported",
      message: this.current.message,
    });
    return this.current;
  }

  async status(): Promise<CodexRuntimeStatus> {
    return this.observeRuntime();
  }

  async switchAccount(request: CodexSwitchRequest): Promise<CodexActionResult> {
    const existing = this.requestResults.get(request.requestId);
    if (existing) return existing;
    const status = await this.observeRuntime();
    const profile = this.profiles.find((candidate) => candidate.accountKey === request.accountKey);
    if (!profile || !REQUEST_ID_RE.test(request.requestId)) {
      return this.remember(request.requestId, {
        ok: false,
        code: "bad_request",
        message: "The account switch request is invalid.",
        status,
      });
    }
    if (request.expectedGeneration !== undefined && request.expectedGeneration !== status.generation) {
      return this.remember(request.requestId, {
        ok: false,
        code: "stale_generation",
        message: "Codex changed while this switch was prepared. Observe it again and try deliberately.",
        status,
      });
    }
    if (this.locked) {
      return this.remember(request.requestId, {
        ok: false,
        code: "busy",
        message: "Another Codex operation is already in progress.",
        status,
      });
    }
    this.locked = true;
    try {
      // Capability evidence for codex-cli 0.153.4 / Windows package
      // 26.903.9818.0 does not expose a control channel for the existing GUI.
      // Do not replace the user's whole CODEX_HOME or mutate auth files here.
      const result: CodexActionResult = {
        ok: false,
        code: "unsupported",
        message: "This Codex build does not expose a supported switch for the running desktop app. Sign in through Codex when prompted, then retry after a verified upgrade.",
        status,
      };
      return this.remember(request.requestId, result);
    } finally {
      this.locked = false;
    }
  }

  async connectAccount(accountKey: string): Promise<CodexActionResult> {
    const status = await this.observeRuntime();
    const profile = this.profiles.find((candidate) => candidate.accountKey === accountKey);
    if (!profile) {
      return { ok: false, code: "bad_request", message: "The account is not enrolled for this owner.", status };
    }
    if (this.startEnrollment) {
      const started = await this.startEnrollment(profile);
      if (started.ok) {
        return { ok: true, code: "started", message: started.message, status };
      }
      return { ok: false, code: "needs_sign_in", message: started.message, status };
    }
    return {
      ok: false,
      code: "needs_sign_in",
      message: `${profile.label} needs a one-time browser sign-in in an isolated Codex profile before it can be monitored.`,
      status,
    };
  }

  private remember(requestId: string, result: CodexActionResult): CodexActionResult {
    if (REQUEST_ID_RE.test(requestId)) this.requestResults.set(requestId, result);
    return result;
  }

  private unsupportedStatus(message: string): CodexRuntimeStatus {
    return {
      state: "unsupported",
      accountKey: null,
      label: null,
      ...emptyIdentity(),
      deviceId: this.deviceId,
      observedAt: Date.now(),
      generation: this.generation,
      confidence: "unsupported",
      switchSupported: false,
      message,
    };
  }
}
