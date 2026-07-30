"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  Code2,
  Download,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The update dialog, loaded inside the desktop app's update popup window.
 *
 * In the popup, `window.duitsiniDesktop` is exposed by `preload-update.ts` and
 * is the ONLY way to trigger a download / restart. In a regular browser that
 * global is absent, so the page degrades to a "download the latest" link — it
 * is never a dead end.
 *
 * This page is public (no auth): the popup opens it directly, and it carries no
 * sensitive data.
 */

interface DesktopBridge {
  getInfo: () => {
    currentVersion: string;
    newVersion: string;
    releaseUrl: string;
  } | null;
  startDownload: () => void;
  onProgress: (cb: (p: { percent: number }) => void) => () => void;
  onDownloaded: (cb: (version: string) => void) => () => void;
  installAndRestart: () => void;
}

function getBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { duitsiniDesktop?: DesktopBridge };
  return w.duitsiniDesktop ?? null;
}

const GITHUB_OWNER = "pmgwee";
const GITHUB_REPO = "DuitSini";

type Phase = "idle" | "downloading" | "downloaded";

export default function DesktopUpdatePage() {
  const params = useSearchParams();
  const fromVersion = params.get("from") ?? "?";
  const toVersion = params.get("to") ?? "?";

  const [bridge] = useState(() => getBridge());
  const [notes, setNotes] = useState<string | null>(null);
  const [notesError, setNotesError] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [percent, setPercent] = useState(0);

  // Fetch the release notes from GitHub for the target version.
  useEffect(() => {
    let cancelled = false;
    fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/v${toVersion}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { body?: string }) => {
        if (!cancelled) setNotes(d.body ?? "Release notes will appear here.");
      })
      .catch(() => {
        if (!cancelled) setNotesError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [toVersion]);

  // Subscribe to download progress + completion from the desktop bridge.
  useEffect(() => {
    if (!bridge) return;
    const offProgress = bridge.onProgress((p) => {
      setPhase("downloading");
      setPercent(p.percent);
    });
    const offDownloaded = bridge.onDownloaded(() => setPhase("downloaded"));
    return () => {
      offProgress();
      offDownloaded();
    };
  }, [bridge]);

  const releaseUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${toVersion}`;

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-6">
      <div className="glass card-elevated w-full max-w-md rounded-3xl border border-border/60 p-7">
        <div className="flex items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
            <RefreshCw className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">Update available</h1>
            <p className="text-sm text-muted-foreground">
              v{fromVersion} → <span className="font-medium text-foreground">v{toVersion}</span>
            </p>
          </div>
        </div>

        {/* Release notes */}
        <div className="mt-5 max-h-52 overflow-y-auto rounded-2xl border border-border/50 bg-surface-2/50 p-4">
          {notesError ? (
            <p className="text-sm text-muted-foreground">
              Couldn&apos;t load release notes.{" "}
              <a href={releaseUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                View on GitHub →
              </a>
            </p>
          ) : notes === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading release notes…
            </div>
          ) : (
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
              {notes}
            </div>
          )}
        </div>

        {/* Links — release page, GitHub, website */}
        <div className="mt-5 flex flex-wrap gap-2">
          <LinkChip href={releaseUrl} icon={ExternalLink} label="Release notes" />
          <LinkChip href={`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`} icon={Code2} label="GitHub" />
          <LinkChip href="https://duitsini.vercel.app/" icon={Globe} label="Website" />
        </div>

        {/* Action button — changes with the phase */}
 <div className="mt-6">
          {!bridge ? (
            // Opened in a regular browser — no update bridge. Offer the download.
            <Button asChild size="lg" className="w-full gap-2">
              <a href={`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`} target="_blank" rel="noreferrer">
                <Download className="size-4" /> Download the latest version
              </a>
            </Button>
          ) : phase === "downloaded" ? (
            <Button size="lg" className="w-full gap-2" onClick={() => bridge.installAndRestart()}>
              <CheckCircle2 className="size-4" /> Restart to update
            </Button>
          ) : phase === "downloading" ? (
            <Button size="lg" className="w-full gap-2" disabled>
              <Loader2 className="size-4 animate-spin" /> Updating… {percent}%
            </Button>
          ) : (
            <Button size="lg" className="w-full gap-2" onClick={() => bridge.startDownload()}>
              <Download className="size-4" /> Update to v{toVersion}
            </Button>
          )}
          {phase === "downloading" && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-foreground/15">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function LinkChip({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: typeof ExternalLink;
  label: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-3.5" />
      {label}
    </a>
  );
}
