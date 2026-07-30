import Link from "next/link";
import { Download, Monitor, Apple, Activity, Bell, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroVideo } from "@/components/hero-video";

/**
 * Public download landing page (no auth). Resolves the latest Windows installer
 * from the GitHub Releases API server-side (cached 1h to stay well within the
 * 60-req/h unauthenticated limit — at most 24 fetches/day). If the fetch fails,
 * degrades to a button linking the releases page so the download never breaks.
 */

const GITHUB_OWNER = "pmgwee";
const GITHUB_REPO = "DuitSini";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface Release {
  tag_name: string;
  name: string | null;
  html_url: string;
  assets: ReleaseAsset[];
}

async function getLatestRelease(): Promise<Release | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      // Cache for an hour — the release changes rarely, and this keeps us far
      // under the unauthenticated rate limit.
      next: { revalidate: 3600 },
    });
    if (!r.ok) return null;
    return (await r.json()) as Release;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

export default async function DownloadPage() {
  const release = await getLatestRelease();
  const tag = release?.tag_name ?? "latest";
  const versionLabel = tag.startsWith("v") ? tag.slice(1) : tag;

  // The Windows NSIS installer is named DuitSini-Setup-*.exe. The blockmap and
  // latest.yml are also in the release (for auto-update) but only the .exe is
  // what a user downloads.
  const winAsset = release?.assets.find(
    (a) => a.name.endsWith(".exe") && a.name.includes("Setup"),
  );
  const winUrl = winAsset?.browser_download_url ?? `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const winSize = winAsset ? formatBytes(winAsset.size) : "~96 MB";

  return (
    <main className="relative w-full overflow-hidden bg-background">
      <HeroVideo src="/upscaled-video%20(1).mp4" />

      <div className="relative z-10 mx-auto flex min-h-dvh max-w-3xl flex-col items-center justify-center px-6 py-20 text-center">
        <div className="flex items-center gap-2.5">
          <img
            src="/logos/duitsini-logo.svg"
            alt=""
            width={36}
            height={36}
            className="size-9 rounded-[10px] shadow-[0_4px_16px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
          />
          <span className="text-2xl font-bold tracking-tight text-white text-shadow-[0_2px_10px_rgba(0,0,0,0.7)]">
            DuitSini Desktop
          </span>
        </div>

        <h1 className="mt-6 text-3xl font-semibold tracking-tight text-balance text-white text-shadow-[0_2px_14px_rgba(0,0,0,0.7)] sm:text-5xl">
          Track your AI usage — without leaving the app.
        </h1>
        <p className="mt-4 max-w-xl text-balance text-white/90 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
          Install once, sign in with Google, and your Claude / GLM plan usage
          updates live — on every device. No Terminal, no ZIP, no script to
          babysit.
        </p>

        {/* Download card — dark glass over the video (matches the landing page's
            bg-black/70 pattern). The light-mode `glass` class would render a near-
            white card that clashes with the cinematic video; dark glass integrates. */}
        <div className="mt-10 w-full max-w-md rounded-3xl border border-white/15 bg-black/70 p-6 text-left shadow-2xl backdrop-blur-xl">
          {/* Windows */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
                <Monitor className="size-5" />
              </div>
              <div>
                <div className="font-semibold text-white">Windows</div>
                <div className="text-xs text-white/60">
                  v{versionLabel} · {winSize} · Windows 10+
                </div>
              </div>
            </div>
            <Button asChild size="sm" className="gap-2">
              <a href={winUrl} download>
                <Download className="size-4" /> Free
              </a>
            </Button>
          </div>

          <div className="my-4 h-px bg-white/10" />

          {/* macOS */}
          <div className="flex items-center justify-between gap-4 opacity-50">
            <div className="flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded-2xl bg-white/10 text-white/70 ring-1 ring-white/10">
                <Apple className="size-5" />
              </div>
              <div>
                <div className="font-semibold text-white">macOS</div>
                <div className="text-xs text-white/50">Coming soon</div>
              </div>
            </div>
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/60">Soon</span>
          </div>
        </div>

        {/* What you get */}
        <div className="mt-10 grid w-full max-w-md gap-3 text-left">
          {[
            { icon: Activity, text: "Live Claude Pro & GLM usage tracking" },
            { icon: Bell, text: "System tray + start-at-login" },
            { icon: TerminalSquare, text: "No Terminal, no ZIP, no scripts" },
          ].map(({ icon: Icon, text }) => (
            <div
              key={text}
              className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/40 px-4 py-3 backdrop-blur"
            >
              <Icon className="size-4 shrink-0 text-primary" />
              <span className="text-sm text-white/90">{text}</span>
            </div>
          ))}
        </div>

        <p className="mt-10 text-xs text-white/60 text-shadow-[0_1px_6px_rgba(0,0,0,0.6)]">
          Prefer the browser?{" "}
          <Link href="/" className="text-primary hover:underline">
            Continue in your browser →
          </Link>
        </p>
      </div>
    </main>
  );
}
