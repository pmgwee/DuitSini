"use client";

import { useEffect, useState } from "react";
import { Apple, Check, CheckCircle2, Copy, Download, Share2, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { AgentProviderIcon } from "./agent-provider-icon";

type OS = "windows" | "mac";

/** A usage source the bridge is currently broadcasting (from the live poll). */
type ConnectedSource = { source: string; label: string };

type LiveResponse = {
  error?: string;
  streams?: { source?: string; label?: string }[] | null;
  sharer_version?: string | null;
};

/**
 * Member-facing "share your Claude usage" card. OS-aware for first-time setup,
 * and status-aware once the bridge is running:
 *
 *   - NOT connected → first-time setup: Windows (download ZIP + double-click
 *     launcher) or macOS (copy-paste Terminal command; macOS blocks browser-
 *     downloaded double-click files via Gatekeeper, but a curl→node command the
 *     user types isn't quarantined — the Homebrew/nvm/Bun pattern).
 *   - Connected → hide the setup steps and show one showcase card per source
 *     the bridge is currently pushing (e.g. "Claude Pro", "GLM Coding"), plus a
 *     single re-download link.
 */
export function ConnectClaudeCard() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [sources, setSources] = useState<ConnectedSource[]>([]);
  const [sharerVersion, setSharerVersion] = useState<string | null>(null);
  const [os, setOs] = useState<OS>("windows");
  // True only when rendered inside the DuitSini desktop app (the Electron shell
  // exposes `window.isDuitSiniDesktop` via contextBridge). Stays false in any
  // plain browser, so the legacy .bat/Terminal steps keep rendering there.
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    // Detect the desktop shell. Initial state must be false: this component is
    // prerendered on the server where `window` is undefined.
    if ((window as unknown as { isDuitSiniDesktop?: boolean }).isDuitSiniDesktop === true) {
      setIsDesktop(true);
      return;
    }
    // Default the tab to the visitor's OS (they can still switch, e.g. to help a
    // friend on the other platform).
    const ua = navigator.userAgent;
    const platform = (navigator as unknown as { platform?: string }).platform ?? "";
    if (/Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/i.test(ua)) setOs("mac");
  }, []);

  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const r = await fetch("/api/claude-usage/live", { headers: { Accept: "application/json" } });
        const d = (await r.json().catch(() => ({ error: "x" }))) as LiveResponse;
        if (!active) return;
        const isConn = r.ok && !d.error;
        setConnected(isConn);
        setSharerVersion(typeof d.sharer_version === "string" ? d.sharer_version : null);
        if (isConn && Array.isArray(d.streams)) {
          setSources(
            d.streams
              .filter((s) => s && (s.source || s.label))
              .map((s) => ({
                source: String(s.source || "claude"),
                label: String(s.label || "Claude"),
              })),
          );
        }
      } catch {
        if (active) setConnected(false);
      }
    };
    check();
    const id = setInterval(check, 10_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="rounded-2xl border border-border/60 bg-surface/40 p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Share2 className="size-4 text-primary" /> Share your agent usage
        </div>
        {connected ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
            <CheckCircle2 className="size-3" /> Connected
          </span>
        ) : null}
      </div>

      {connected === null ? (
        <ConnectCardSkeleton />
      ) : connected ? (
        <ConnectedView sources={sources} isDesktop={isDesktop} sharerVersion={sharerVersion} />
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            See Claude, GLM, and ChatGPT Codex usage here, live — no coding needed. The same sharer
            auto-detects every existing local sign-in; Codex needs no separate download, key, or setup.
          </p>

          {isDesktop ? (
            <DesktopPanel os={os} />
          ) : (
            <>
              {/* OS switch */}
              <div className="mb-4 inline-flex items-center gap-1 rounded-xl border border-border/60 bg-surface/50 p-1 text-sm">
                <OsTab active={os === "windows"} onClick={() => setOs("windows")} icon={<WindowsGlyph />}>
                  Windows
                </OsTab>
                <OsTab active={os === "mac"} onClick={() => setOs("mac")} icon={<Apple className="size-4" />}>
                  macOS
                </OsTab>
              </div>

              {os === "windows" ? <WindowsPanel /> : <MacPanel />}
            </>
          )}

          {!isDesktop && (
            <details className="mt-3 rounded-lg border border-border/40 bg-surface/30 px-3 py-2 text-[11px] text-muted-foreground/80">
            <summary className="cursor-pointer select-none font-medium text-muted-foreground">
              Want Claude Pro, GLM, and Codex live at once?
            </summary>
            <p className="mt-1.5">
              Claude usage is account-level, so any Claude Code login with your Pro/Max account shows the
              same numbers — no need for Claude Desktop. To keep a Pro login separate from a GLM-routed
              CLI, sign in once into a dedicated folder:
            </p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              <li>
                Windows:{" "}
                <code className="font-mono text-[10px]">
                  $env:CLAUDE_CONFIG_DIR=&quot;$env:USERPROFILE\.claude-pro&quot;; cmd /c claude
                </code>{" "}
                → choose <b className="text-foreground">Claude.ai subscription</b>.
              </li>
              <li>
                Mac:{" "}
                <code className="font-mono text-[10px]">CLAUDE_CONFIG_DIR=~/.claude-pro claude</code>.
              </li>
            </ul>
            <p className="mt-1.5">
              The sharer finds it automatically (plus <code className="font-mono text-[10px]">~/.claude-sub</code>,{" "}
              <code className="font-mono text-[10px]">CLAUDE_SUB_CONFIG_DIR</code>, the{" "}
              <b className="text-foreground">macOS Keychain</b>, and your normal{" "}
              <code className="font-mono text-[10px]">~/.claude</code> — if one sign-in is rejected it
              tries the next and logs which one it&apos;s using). GLM is read from your cc-switch setup,
              while Codex is read automatically from your existing Codex CLI sign-in. All available
              agents then show live side by side.
            </p>
            <p className="mt-1.5">
              Update speed: create <code className="font-mono text-[10px]">sharer-config.json</code> next
              to the sharer script containing{" "}
              <code className="font-mono text-[10px]">{'{ "pushSeconds": 300 }'}</code> (120–3600 seconds;
              default 300) to change the shared query interval for every agent.
            </p>
            </details>
          )}

          <p className="mt-3 text-[11px] text-muted-foreground/70">
            Only your usage percentages are sent — never your password or login.
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading skeleton — shown while the first live-status fetch resolves */
/* (mirrors the ClaudeUsageTracker's skeleton so both cards surface    */
/* their content at the same moment).                                  */
/* ------------------------------------------------------------------ */

function ConnectCardSkeleton() {
  return (
    <div
      className="flex flex-col gap-3"
      role="status"
      aria-live="polite"
      aria-label="Loading usage source status"
    >
      <Skeleton className="h-4 w-72 max-w-full" />
      <Skeleton className="h-4 w-60 max-w-full" />
      <div className="mt-1 flex flex-wrap gap-2">
        <Skeleton className="h-14 w-44 rounded-xl" />
        <Skeleton className="h-14 w-44 rounded-xl" />
      </div>
      <Skeleton className="mt-1 h-9 w-44 rounded-xl" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connected view — showcase the sources the bridge is broadcasting    */
/* ------------------------------------------------------------------ */

function ConnectedView({
  sources,
  isDesktop,
  sharerVersion,
}: {
  sources: ConnectedSource[];
  isDesktop: boolean;
  sharerVersion: string | null;
}) {
  const scriptVersion = sharerVersion ? Number.parseInt(sharerVersion, 10) : null;
  const needsV8 =
    !isDesktop &&
    !sharerVersion?.startsWith("desktop-") &&
    (scriptVersion === null || !Number.isFinite(scriptVersion) || scriptVersion < 8);
  return (
    <div>
      {needsV8 ? (
        <div className="mb-4 flex flex-col gap-2 rounded-xl border border-primary/25 bg-primary/8 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium text-foreground">Update once to add ChatGPT Codex</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Replace the old sharer with v8. It reuses the same setup and automatically finds Codex.
            </p>
          </div>
          <Button asChild size="sm" className="shrink-0">
            <a href="/api/bridge/download">
              <Download className="size-3.5" /> Update sharer
            </a>
          </Button>
        </div>
      ) : null}
      {sources.length > 0 ? (
        <>
          <p className="mb-2.5 text-xs text-muted-foreground">Usage sources tracking now:</p>
          <div className="flex flex-wrap gap-2">
            {sources.map((s) => (
              <SourceCard key={s.source} source={s.source} label={s.label} />
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Your usage is broadcasting to this dashboard — nice!
        </p>
      )}

      {isDesktop ? (
        <p className="mt-4 text-xs text-muted-foreground">
          The desktop app is tracking this in the background — keep it running (it can hide to the
          tray and start at login).
        </p>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          Keep the sharer window open to stay live.{" "}
          <a
            href="/api/bridge/download"
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Re-download sharer
          </a>{" "}
          · to stop, close the window.
        </p>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground/70">
        If one source ever needs a fresh sign-in, sign in to that CLI again on this computer —
        {isDesktop ? " the desktop app picks it up automatically." : " the sharer picks it up automatically."}
      </p>
    </div>
  );
}

/** One showcase card: the platform mark + a live indicator. */
function SourceCard({ source, label }: { source: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-surface/50 px-3 py-2">
      <AgentProviderIcon source={source} size="lg" />
      <div className="min-w-0">
        <div className="text-sm font-medium leading-tight">{label}</div>
        <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-success">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success/70" />
            <span className="relative inline-flex size-1.5 rounded-full bg-success" />
          </span>
          Live
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* First-time setup panels                                            */
/* ------------------------------------------------------------------ */

function WindowsPanel() {
  return (
    <>
      <Button asChild size="lg">
        <a href="/api/bridge/download">
          <Download className="size-4" /> Download my usage sharer
        </a>
      </Button>

      <ol className="mt-4 space-y-2.5 text-sm text-muted-foreground">
        <Step n={1}>Click the button above and save the ZIP file.</Step>
        <Step n={2}>
          Open it and unzip (right-click → <b className="text-foreground">Extract All</b>).
        </Step>
        <Step n={3}>
          Double-click <b className="text-foreground">START-HERE (Windows)</b>. Keep the window that
          opens open.
        </Step>
        <Step n={4}>Done! Every detected agent appears above, live. Close the window anytime to stop.</Step>
      </ol>
    </>
  );
}

function MacPanel() {
  const [command, setCommand] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/bridge/mac-command", { headers: { Accept: "application/json" } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.command) throw new Error(d.error || "Couldn't prepare your command.");
      setCommand(d.command);
      setAccount(typeof d.account === "string" ? d.account : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the user can still select the text manually */
    }
  };

  return (
    <>
      {command ? (
        <div className="rounded-xl border border-border/60 bg-surface/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <Terminal className="size-3.5" /> Your command
            </span>
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-surface/60 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <code className="block select-all overflow-x-auto whitespace-pre rounded-lg bg-background/70 px-3 py-2 font-mono text-xs text-foreground">
            {command}
          </code>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Personal to <b className="text-foreground">{account ?? "your sign-in"}</b> — everything
            this command shares lands on this account. Don&apos;t pass it to someone else; each
            member copies their own from their own sign-in.
          </p>
        </div>
      ) : (
        <Button size="lg" onClick={reveal} disabled={loading}>
          <Terminal className="size-4" /> {loading ? "Preparing…" : "Get my Mac command"}
        </Button>
      )}

      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}

      <ol className="mt-4 space-y-2.5 text-sm text-muted-foreground">
        <Step n={1}>Click the button above to reveal your one-line command, then copy it.</Step>
        <Step n={2}>
          Open <b className="text-foreground">Terminal</b> (press <b className="text-foreground">Cmd
          + Space</b>, type “Terminal”, press Enter).
        </Step>
        <Step n={3}>
          Paste the command, press <b className="text-foreground">Enter</b>. Keep that window open.
        </Step>
        <Step n={4}>Done! Every detected agent appears above, live. Close the window anytime to stop.</Step>
      </ol>

      <p className="mt-3 text-[11px] text-muted-foreground/70">
        No Node yet? If it says <span className="font-mono">command not found: node</span>, install
        the LTS from nodejs.org, then paste the command again.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Desktop app panel — shown only when `window.isDuitSiniDesktop`      */
/* (the shell tracks automatically; the .bat/Terminal script is not    */
/* needed). One real step: sign Claude Code in once.                    */
/* ------------------------------------------------------------------ */

function DesktopPanel({ os }: { os: OS }) {
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">
        You&apos;re in the <b className="text-foreground">DuitSini desktop app</b> — Claude, GLM,
        and ChatGPT Codex are detected automatically from their existing local sign-ins. No script,
        extra key, or second setup is needed.
      </p>

      <ol className="space-y-2.5 text-sm text-muted-foreground">
        <Step n={1}>
          To see your Claude Pro/Max usage, sign Claude Code in once with your subscription account.
          Open a terminal and run{" "}
          <code className="font-mono text-[11px]">{os === "mac" ? "claude" : "cmd /c claude"}</code>,
          then choose <b className="text-foreground">Claude.ai subscription</b> and sign in.
        </Step>
        <Step n={2}>
          Already signed in to Codex CLI? There is nothing else to do — its 7-day subscription
          usage appears alongside the other agents on the same update interval.
        </Step>
      </ol>

      <details className="mt-3 rounded-lg border border-border/40 bg-surface/30 px-3 py-2 text-[11px] text-muted-foreground/80">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground">
          Routing Claude Code to GLM via cc-switch? Keep the two logins separate.
        </summary>
        <p className="mt-1.5">
          Claude usage is account-level. If your Claude Code points at a GLM gateway through
          cc-switch, sign your Claude Pro/Max account in once into a dedicated folder so both track
          side by side:
        </p>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          <li>
            Windows:{" "}
            <code className="font-mono text-[10px]">
              $env:CLAUDE_CONFIG_DIR=&quot;$env:USERPROFILE\.claude-pro&quot;; cmd /c claude
            </code>{" "}
            → choose <b className="text-foreground">Claude.ai subscription</b>.
          </li>
          <li>
            Mac:{" "}
            <code className="font-mono text-[10px]">CLAUDE_CONFIG_DIR=~/.claude-pro claude</code>.
          </li>
        </ul>
        <p className="mt-1.5">
          The desktop app finds it automatically (plus{" "}
          <code className="font-mono text-[10px]">~/.claude-sub</code>,{" "}
          <code className="font-mono text-[10px]">CLAUDE_SUB_CONFIG_DIR</code>, the{" "}
          <b className="text-foreground">macOS Keychain</b>, and your normal{" "}
          <code className="font-mono text-[10px]">~/.claude</code>). GLM itself needs no extra step —
          it&apos;s read from cc-switch.
        </p>
      </details>
    </>
  );
}

function OsTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function WindowsGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
      <path d="M3 5.6 10.4 4.6v7.1H3V5.6Zm0 12.8 7.4 1v-7H3v6ZM11.3 4.5 21 3v8.7h-9.7V4.5Zm0 8.2H21V21l-9.7-1.4v-6.9Z" />
    </svg>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}
