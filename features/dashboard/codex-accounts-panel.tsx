"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleAlert, Laptop, LockKeyhole, RefreshCw, UserRound } from "lucide-react";
import {
  accountForCodexStream,
  CODEX_ACCOUNT_SLOTS,
  sortCodexAccounts,
  type CodexAccountMetadata,
} from "@/lib/claude-usage/codex-accounts";
import { cn } from "@/lib/utils";
import type { UsageStream, LiveUsageWindow } from "./use-claude-usage-live";

type RuntimeStatus = {
  state: "detected" | "unknown" | "not_running" | "unsupported";
  accountKey: string | null;
  label: string | null;
  email: string | null;
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
  syncAccounts?: (accounts: unknown) => Promise<{ ok: boolean; code?: string; message?: string }>;
};

type DeviceRow = {
  id: string;
  device_name: string;
  protocol_version: number;
  switch_supported: boolean;
  active_account_key: string | null;
  heartbeat_at: string;
  generation: number;
};

type SwitchLog = { at: number; label: string; result: string };

function emptyAccount(slot: (typeof CODEX_ACCOUNT_SLOTS)[number]): CodexAccountMetadata {
  return {
    account_key: slot.account_key,
    slot: slot.slot,
    label: slot.label,
    email: null,
    workspace_id: null,
    workspace_name: null,
    plan_type: null,
    connected: false,
    verified: false,
    status: "needs_sign_in",
    device_id: null,
    last_seen_at: null,
  };
}

function resetText(iso: string | null | undefined, now: number | null): string {
  if (!iso) return "reset unknown";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts) || now === null) return "reset time available";
  if (ts <= now) return "reset time passed; awaiting update";
  const mins = Math.ceil((ts - now) / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.floor(hours / 24)}d`;
}

function windowPercent(window: LiveUsageWindow | null | undefined): number | null {
  if (!window || window.utilization === null || window.utilization === undefined) return null;
  return Math.max(0, Math.min(100, window.utilization));
}

function accountPercent(stream: UsageStream | undefined, window: LiveUsageWindow | null | undefined, now: number | null): number | null {
  if (stream && stream.state !== "live" && window?.resets_at && now !== null && Date.parse(window.resets_at) <= now) {
    return null;
  }
  return windowPercent(window);
}

function streamStatus(stream: UsageStream | undefined, account: CodexAccountMetadata): string {
  if (stream?.state === "rate_limited") return "Rate limited; saved reading shown";
  if (stream?.state === "auth_stale") return "Sign in again to resume";
  if (stream?.state === "offline" || stream?.cached) return "Saved reading; companion offline";
  if (stream?.state === "live") return stream.account_email ? "Connected · live quota" : "Connected · identity pending";
  if (account.status === "needs_sign_in") return "Needs one-time sign-in";
  if (account.status === "unsupported") return "Unsupported by installed Codex build";
  return "No authoritative quota reading yet";
}

export function CodexAccountsPanel({ streams, now }: { streams: UsageStream[]; now: number | null }) {
  const [accounts, setAccounts] = useState<CodexAccountMetadata[]>(() => CODEX_ACCOUNT_SLOTS.map(emptyAccount));
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [desktop, setDesktop] = useState<CodexDesktopCapability | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [switchLog, setSwitchLog] = useState<SwitchLog[]>([]);
  const syncedAccountsRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("/api/codex/accounts", { headers: { Accept: "application/json" }, cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { accounts?: CodexAccountMetadata[]; devices?: DeviceRow[] };
        if (alive && Array.isArray(body.accounts)) setAccounts(sortCodexAccounts(body.accounts));
        if (alive && Array.isArray(body.devices)) setDevices(body.devices);
      } catch {
        // The cards remain visible with their explicit disconnected shells.
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

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
    }).catch(() => {
      // Metadata sync is an enhancement; quota cards remain usable if an older
      // desktop build does not accept the optional IPC method.
    });
  }, [accounts, desktop]);

  const { streamsByAccount, unassignedStreams } = useMemo(() => {
    const map = new Map<string, UsageStream>();
    const unassigned: UsageStream[] = [];
    for (const stream of streams) {
      if (stream.source !== "codex") continue;
      const account = accountForCodexStream(stream, accounts);
      if (!account) {
        unassigned.push(stream);
        continue;
      }
      const key = account.account_key;
      const previous = map.get(key);
      if (!previous || (previous.cached && !stream.cached)) map.set(key, stream);
    }
    return { streamsByAccount: map, unassignedStreams: unassigned };
  }, [streams, accounts]);
  const reportingDevice = devices[0];
  const runtimeAccount = runtime?.accountKey ? accounts.find((account) => account.account_key === runtime.accountKey) : null;
  const runtimeCopy = runtime?.state === "detected" && runtimeAccount
    ? `Codex is using ${runtimeAccount.label} on this computer.`
    : runtime?.accountKey && runtimeAccount
      ? `Credential source matches ${runtimeAccount.label}; the running GUI is not verified.`
      : runtime?.state === "not_running"
        ? "Codex is not running or no local sign-in is available."
        : "Active account could not be verified.";
  const runtimeDetail = runtime?.email
    ? `${runtime.email}${runtime.workspaceName ? ` · ${runtime.workspaceName}` : ""}`
    : reportingDevice
      ? `Last reported on ${reportingDevice.device_name}`
      : "This computer has no verified Codex runtime identity.";
  const switchReady = desktop !== null && runtime?.switchSupported === true;

  const switchTo = async (account: CodexAccountMetadata) => {
    setNotice(null);
    if (!desktop) {
      setNotice("Open or update DuitSini Desktop to switch Codex on this computer.");
      return;
    }
    setSwitching(account.account_key);
    const requestId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `switch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const result = await desktop.switchAccount({ accountKey: account.account_key, requestId, expectedGeneration: runtime?.generation ?? 0 });
      const text = result.ok ? "Already using this account." : result.message ?? "Codex could not switch this account.";
      setNotice(text);
      setSwitchLog((previous) => [{ at: Date.now(), label: account.label, result: result.ok ? "already active" : result.code ?? "failed" }, ...previous].slice(0, 5));
      if (result.status) setRuntime(result.status);
    } catch (error) {
      setNotice((error as Error).message);
      setSwitchLog((previous) => [{ at: Date.now(), label: account.label, result: "rejected" }, ...previous].slice(0, 5));
    } finally {
      setSwitching(null);
    }
  };

  const connect = async (account: CodexAccountMetadata) => {
    setNotice(null);
    if (!desktop) {
      setNotice("Install or open DuitSini Desktop to connect this account on the paired computer.");
      return;
    }
    setSwitching(account.account_key);
    try {
      const result = await desktop.connectAccount(account.account_key);
      setNotice(result.ok ? result.message ?? "Codex sign-in opened in an isolated profile." : result.message ?? "This account needs sign-in.");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setSwitching(null);
    }
  };

  return (
    <section aria-labelledby="codex-accounts-heading" className="flex flex-col gap-3 rounded-2xl border border-border/50 bg-surface/20 p-3">
      <div className="flex items-start gap-2">
        <Laptop className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="codex-accounts-heading" className="text-sm font-semibold">Your two Codex accounts</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{runtimeCopy}</p>
          <p className="text-[11px] text-muted-foreground/80">{runtimeDetail}</p>
          <p className="mt-1 text-[11px] text-muted-foreground/70">Only a deliberate switch button changes the Codex account.</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {accounts.map((account) => {
          const stream = streamsByAccount.get(account.account_key);
          const session = accountPercent(stream, stream?.five_hour, now);
          const weekly = accountPercent(stream, stream?.seven_day, now);
          const isVerifiedActive = runtime?.state === "detected" && runtime.accountKey === account.account_key;
          const status = streamStatus(stream, account);
          return (
            <article key={account.account_key} className={cn("flex min-w-0 flex-col gap-3 rounded-xl border p-3", isVerifiedActive ? "border-primary ring-1 ring-primary/50" : "border-border/60 bg-background/20")}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                  <UserRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{account.label}</h3>
                    <p className="break-words text-[11px] text-muted-foreground">{stream?.account_email ?? account.email ?? "Email pending verification"}</p>
                  </div>
                </div>
                {isVerifiedActive ? <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary"><Check className="size-3" /> In use</span> : null}
              </div>

              <div className="min-h-8 text-[11px] text-muted-foreground">
                <span className={cn("font-medium", stream?.state === "auth_stale" || account.status === "needs_sign_in" ? "text-warning" : "text-foreground/80")}>{status}</span>
                {(account.workspace_name || stream?.workspace_name || account.plan_type || stream?.plan_type) ? <span className="mt-0.5 block">{stream?.workspace_name ?? account.workspace_name ?? "Workspace unknown"}{(stream?.plan_type ?? account.plan_type) ? ` · ${stream?.plan_type ?? account.plan_type}` : ""}</span> : <span className="mt-0.5 block">Workspace and plan are verified after account connection.</span>}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <QuotaBar label="5-hour" percent={session} reset={stream?.five_hour?.resets_at} now={now} />
                <QuotaBar label="7-day" percent={weekly} reset={stream?.seven_day?.resets_at} now={now} />
              </div>
              <p className="text-[10px] text-muted-foreground/70">{stream?.observed_at && now !== null ? `Last successful observation ${relativeTime(stream.observed_at, now)}.` : "No successful quota observation yet."}</p>

              <div className="mt-auto flex flex-wrap gap-2">
                {(account.status === "needs_sign_in" && !stream) || stream?.state === "auth_stale" ? desktop ? <button type="button" onClick={() => void connect(account)} disabled={switching === account.account_key} className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-warning/60 bg-warning/10 px-2.5 py-1.5 text-[11px] font-semibold text-warning hover:bg-warning/15 disabled:opacity-60"><LockKeyhole className="size-3.5" /> {switching === account.account_key ? "Opening sign-in…" : stream?.state === "auth_stale" ? "Sign in again" : "Connect account"}</button> : <a href="/download" className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-warning/60 bg-warning/10 px-2.5 py-1.5 text-[11px] font-semibold text-warning hover:bg-warning/15"><LockKeyhole className="size-3.5" /> Open Desktop to connect</a> : null}
                {desktop ? <button type="button" onClick={() => void switchTo(account)} disabled={!switchReady || switching !== null || isVerifiedActive} aria-label={isVerifiedActive ? `Already using ${account.label}` : switchReady ? `Use ${account.label}` : `Switching ${account.label} is unavailable`} title={switchReady ? undefined : "The installed Codex app does not expose a supported running-GUI account switch."} className={cn("inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60", isVerifiedActive ? "border border-primary/50 bg-primary/10 text-primary" : "bg-primary text-primary-foreground hover:bg-primary/90")}>
                  {switching === account.account_key ? <RefreshCw className="size-3.5 animate-spin" /> : isVerifiedActive ? <Check className="size-3.5" /> : null}
                  {switching === account.account_key ? "Checking…" : isVerifiedActive ? "Already using this account" : switchReady ? `Use ${account.label}` : runtime ? "Switch unavailable" : "Checking switch support…"}
                </button> : <a href="/download" aria-label={`Open DuitSini Desktop to use ${account.label}`} className="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/90">Open/Update Desktop</a>}
              </div>
            </article>
          );
        })}
      </div>

      {unassignedStreams.length > 0 ? (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0">
              <h3 className="text-xs font-semibold">Codex usage · identity pending</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                A legacy Codex bridge reported usage without an enrolled account identity. It is kept here until the next verified sign-in.
              </p>
            </div>
          </div>
          {unassignedStreams.map((stream, index) => (
            <div key={`${stream.source}-${stream.observed_at ?? index}`} className="mt-2 grid grid-cols-2 gap-2">
              <QuotaBar label="5-hour" percent={accountPercent(stream, stream.five_hour, now)} reset={stream.five_hour?.resets_at} now={now} />
              <QuotaBar label="7-day" percent={accountPercent(stream, stream.seven_day, now)} reset={stream.seven_day?.resets_at} now={now} />
            </div>
          ))}
        </div>
      ) : null}

      {notice ? <div role="status" className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] text-warning"><CircleAlert className="mt-0.5 size-3.5 shrink-0" /> <span>{notice}</span></div> : null}
      <details className="text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none">Recent switches</summary>
        <div className="mt-2 flex flex-col gap-1 border-l border-border/50 pl-3">
          {switchLog.length === 0 ? <span>No switches in this session.</span> : switchLog.map((entry) => <span key={`${entry.at}-${entry.label}`}>{entry.label} · {entry.result}</span>)}
        </div>
      </details>
    </section>
  );
}

function QuotaBar({ label, percent, reset, now }: { label: string; percent: number | null; reset: string | null | undefined; now: number | null }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-1 text-[10px]"><span>{label}</span><span className="font-semibold tabular-nums">{percent === null ? "Unknown" : `${Math.round(percent)}% used`}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent ?? 0}%` }} /></div>
      <div className="mt-1 truncate text-[10px] text-muted-foreground">{resetText(reset, now)}</div>
    </div>
  );
}

function relativeTime(iso: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(iso));
  if (diff < 45_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
