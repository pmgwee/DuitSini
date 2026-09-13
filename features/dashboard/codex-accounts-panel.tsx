"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, Laptop, LockKeyhole, RefreshCw, UserRound } from "lucide-react";
import {
  accountForCodexStream,
  codexStreamsByAccount,
  type CodexAccountMetadata,
} from "@/lib/claude-usage/codex-accounts";
import { cn } from "@/lib/utils";
import type { CodexDeviceRow } from "./use-codex-accounts";
import type { UsageStream } from "./use-claude-usage-live";

type RuntimeStatus = {
  state: "detected" | "unknown" | "not_running" | "unsupported";
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
  switchSupported: boolean;
  message: string;
};

type CodexDesktopCapability = {
  getStatus: () => Promise<RuntimeStatus>;
  switchAccount: (request: unknown) => Promise<{ ok: boolean; code?: string; message?: string; status?: RuntimeStatus }>;
  connectAccount: (accountKey: unknown) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** Added in Desktop 1.5.1; its presence is also the compatibility gate. */
  syncAccounts?: (accounts: unknown) => Promise<{ ok: boolean; code?: string; message?: string }>;
};

type SwitchLog = { at: number; label: string; result: string };

function connectionStatus(
  stream: UsageStream | undefined,
  account: CodexAccountMetadata,
  credentialActive: boolean,
): string {
  /*
   * A parked seat's access token stops answering the usage endpoint once Codex
   * stops using it — measured 2026-09-13: a 401 while the token's own `exp` was
   * still eight days out, so this is a server-side invalidation, not a local
   * expiry. Its refresh token is intact, and Codex renews it as soon as the
   * seat is active again. Calling that "Sign in again" reads as "you must log
   * in before you can switch", which is the opposite of what is needed.
   */
  if (stream?.state === "auth_stale") {
    return credentialActive ? "Sign in again" : "Stored · renews when you switch to it";
  }
  if (stream?.state === "rate_limited") return "Connected · provider cooldown";
  if (stream?.state === "offline" || stream?.cached) return "Connected · companion offline";
  if (stream) return "Connected";
  if (account.status === "needs_sign_in") return "Not connected";
  if (account.status === "unsupported") return "Unsupported by installed Codex build";
  return "Connection unavailable";
}

export function CodexAccountsPanel({
  streams,
  accounts,
  devices,
  directoryReady,
}: {
  streams: UsageStream[];
  accounts: CodexAccountMetadata[];
  devices: CodexDeviceRow[];
  directoryReady: boolean;
}) {
  const [desktop, setDesktop] = useState<CodexDesktopCapability | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "info" | "warning" } | null>(null);
  const [switchLog, setSwitchLog] = useState<SwitchLog[]>([]);
  const syncedAccountsRef = useRef<string | null>(null);

  useEffect(() => {
    const candidate = (window as unknown as { duitsiniCodex?: CodexDesktopCapability }).duitsiniCodex;
    if (!candidate) return;
    let alive = true;
    setDesktop(candidate);
    const refresh = async () => {
      try {
        const status = await candidate.getStatus();
        if (alive) setRuntime(status);
      } catch {
        if (alive) setRuntime(null);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 7_500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!desktop?.syncAccounts || accounts.length === 0) return;
    const signature = accounts
      .map((account) => `${account.account_key}:${account.email ?? ""}:${account.member_id ?? ""}:${account.workspace_id ?? ""}`)
      .join("|");
    if (syncedAccountsRef.current === signature) return;
    void desktop.syncAccounts(accounts).then((result) => {
      if (result.ok) syncedAccountsRef.current = signature;
    }).catch(() => undefined);
  }, [accounts, desktop]);

  const streamsByAccount = useMemo(
    () => directoryReady ? codexStreamsByAccount(streams, accounts) : new Map<string, UsageStream>(),
    [streams, accounts, directoryReady],
  );
  const reportingDevice = devices[0];
  const runtimeAccount = runtime && directoryReady
    ? accountForCodexStream(
        {
          source: "codex",
          account_key: runtime.accountKey,
          account_email: runtime.email,
          member_id: runtime.memberId,
          workspace_id: runtime.workspaceId,
        },
        accounts,
      )
    : null;
  const runtimeCopy = runtimeAccount
    ? runtime?.state === "detected"
      ? `Codex is using ${runtimeAccount.label} on this computer.`
      : `Current Codex credential: ${runtimeAccount.label}.`
    : runtime?.state === "not_running"
      ? "Codex is not running or no local sign-in is available."
      : "Current Codex account could not be identified.";
  const runtimeDetail = runtime?.email
    ? `${runtime.email}${runtime.workspaceName ? ` · ${runtime.workspaceName}` : ""}`
    : runtimeAccount?.email
      ? runtimeAccount.email
      : reportingDevice
        ? `Last reported on ${reportingDevice.device_name}`
        : "No verified runtime identity reported by this computer.";
  const compatibleDesktop = desktop !== null && typeof desktop.syncAccounts === "function";
  const switchReady = compatibleDesktop && runtime?.switchSupported === true;

  const switchTo = async (account: CodexAccountMetadata) => {
    if (!desktop || !switchReady) return;
    setNotice(null);
    setSwitching(account.account_key);
    const requestId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `switch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const result = await desktop.switchAccount({ accountKey: account.account_key, requestId, expectedGeneration: runtime?.generation ?? 0 });
      // The main process writes the outcome copy (it knows whether the
      // credential moved and where the outgoing one was preserved).
      setNotice({
        text: result.message ?? (result.ok ? `Codex now uses ${account.label}.` : "Codex could not switch this account."),
        tone: result.ok ? "info" : "warning",
      });
      setSwitchLog((previous) => [{ at: Date.now(), label: account.label, result: result.code ?? (result.ok ? "switched" : "failed") }, ...previous].slice(0, 5));
      if (result.status) setRuntime(result.status);
    } catch (error) {
      setNotice({ text: (error as Error).message, tone: "warning" });
    } finally {
      setSwitching(null);
    }
  };

  const connect = async (account: CodexAccountMetadata) => {
    if (!desktop || !compatibleDesktop) return;
    setNotice(null);
    setSwitching(account.account_key);
    try {
      const result = await desktop.connectAccount(account.account_key);
      setNotice({
        text: result.message ?? (result.ok ? "Codex sign-in opened in an isolated profile." : "This account needs sign-in."),
        tone: result.ok ? "info" : "warning",
      });
    } catch (error) {
      setNotice({ text: (error as Error).message, tone: "warning" });
    } finally {
      setSwitching(null);
    }
  };

  return (
    <section aria-labelledby="codex-accounts-heading" className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-surface/20 p-3">
      <div className="flex items-start gap-2">
        <Laptop className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="codex-accounts-heading" className="text-sm font-semibold">Codex account controls</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{runtimeCopy}</p>
          <p className="text-[11px] text-muted-foreground/80">{runtimeDetail}</p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">Switching rewrites the Codex sign-in on this computer. A Codex session that is already open keeps its previous account until you restart it.</p>
          <p className="text-[11px] text-muted-foreground/70">Usage is shown in the two standard Codex trackers below.</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {accounts.map((account) => {
          const stream = streamsByAccount.get(account.account_key);
          const credentialActive = runtimeAccount?.account_key === account.account_key;
          const verifiedActive = credentialActive && runtime?.state === "detected";
          // "Has a sign-in stored on this computer" — a seat that has ever
          // reported does, even if its parked token has since gone stale.
          const neverConnected = !stream && account.status !== "connected";
          const staleSignIn = stream?.state === "auth_stale";
          return (
            <article key={account.account_key} className={cn("flex min-w-0 flex-col gap-3 rounded-xl border p-3", credentialActive ? "border-primary ring-1 ring-primary/50" : "border-border/60 bg-background/20")}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <UserRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">{account.label}</h3>
                    <p className="break-words text-[11px] text-muted-foreground">{stream?.account_email ?? account.email ?? "Email pending verification"}</p>
                  </div>
                </div>
                {credentialActive ? <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary"><Check className="size-3" /> {verifiedActive ? "In use" : "Credential active"}</span> : null}
              </div>

              {/* Connection state only: quota lives in this seat's tracker below. */}
              <div className="text-[11px] text-muted-foreground">
                <span className={cn("font-medium", neverConnected || (credentialActive && stream?.state === "auth_stale") ? "text-warning" : "text-foreground/80")}>
                  {connectionStatus(stream, account, credentialActive)}
                </span>
              </div>

              {/*
                Order is the instruction. A seat with a sign-in already stored is
                switched to directly — signing in again is the fallback for when
                its refresh token is genuinely dead, not a prerequisite.
              */}
              <div className="mt-auto flex flex-wrap gap-2">
                {neverConnected ? compatibleDesktop ? (
                  <button type="button" onClick={() => void connect(account)} disabled={switching !== null} className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-warning/60 bg-warning/10 px-2.5 py-1.5 text-[11px] font-semibold text-warning hover:bg-warning/15 disabled:opacity-60"><LockKeyhole className="size-3.5" /> {switching === account.account_key ? "Opening sign-in…" : "Connect account"}</button>
                ) : (
                  <a href="/download" className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-warning/60 bg-warning/10 px-2.5 py-1.5 text-[11px] font-semibold text-warning hover:bg-warning/15"><LockKeyhole className="size-3.5" /> {desktop ? "Update Desktop to connect" : "Open Desktop to connect"}</a>
                ) : null}
                {!neverConnected && compatibleDesktop ? (
                  <button
                    type="button"
                    onClick={() => void switchTo(account)}
                    disabled={credentialActive || !switchReady || switching !== null}
                    aria-label={credentialActive ? `Codex already uses ${account.label}` : switchReady ? `Use ${account.label}` : `Switching to ${account.label} is unavailable`}
                    title={
                      credentialActive
                        ? undefined
                        : switchReady
                          ? "Writes this account's sign-in into the Codex profile. Restart Codex afterwards."
                          : "Connect a second account first — switching needs its sign-in stored on this computer."
                    }
                    className={cn("inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60", credentialActive ? "border border-primary/50 bg-primary/10 text-primary" : "bg-primary text-primary-foreground hover:bg-primary/90")}
                  >
                    {switching === account.account_key ? <RefreshCw className="size-3.5 animate-spin" /> : credentialActive ? <Check className="size-3.5" /> : null}
                    {switching === account.account_key ? "Switching…" : credentialActive ? "Currently in use" : switchReady ? `Use ${account.label}` : "Switch unavailable"}
                  </button>
                ) : !neverConnected ? (
                  <a href="/download" className="inline-flex min-h-8 flex-1 items-center justify-center rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90">{desktop ? "Update Desktop" : "Open/Update Desktop"}</a>
                ) : null}
                {!neverConnected && staleSignIn && compatibleDesktop ? (
                  <button
                    type="button"
                    onClick={() => void connect(account)}
                    disabled={switching !== null}
                    title="Only needed if this account's stored sign-in has expired for good — switching to it normally renews it."
                    className="inline-flex min-h-8 basis-full items-center justify-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
                  >
                    <LockKeyhole className="size-3.5" />
                    {switching === account.account_key ? "Opening sign-in…" : "Sign in again instead"}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {notice ? (
        <div
          role="status"
          className={cn(
            "flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[11px]",
            notice.tone === "warning"
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-primary/40 bg-primary/10 text-primary",
          )}
        >
          {notice.tone === "warning" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> : <Check className="mt-0.5 size-3.5 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      ) : null}
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none">Recent switches</summary>
        <div className="mt-2 flex flex-col gap-1 border-l border-border/50 pl-3">
          {switchLog.length === 0 ? <span>No switches in this session.</span> : switchLog.map((entry) => <span key={`${entry.at}-${entry.label}`}>{entry.label} · {entry.result}</span>)}
        </div>
      </details>
    </section>
  );
}
