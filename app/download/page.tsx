import Link from "next/link";
import { Download, Monitor, Apple, Activity, Bell, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HeroVideo } from "@/components/hero-video";
import {
  formatDesktopReleaseSize,
  getLatestDesktopRelease,
} from "@/lib/releases/desktop-release";

/**
 * Public download landing page (no auth). Reads electron-builder's updater
 * manifest, the same file the installed app trusts, so a newly published
 * installer can never be advertised under the previous version.
 */

export default async function DownloadPage() {
  const release = await getLatestDesktopRelease();
  const versionLabel = release.version ? `v${release.version}` : "Latest version";
  const sizeLabel = formatDesktopReleaseSize(release.sizeBytes);
  const metadata = [versionLabel, sizeLabel, "Windows 10+"].filter(Boolean).join(" · ");

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
          Install once and DuitSini automatically brings your Claude, Codex,
          and Z.AI subscription usage into one live dashboard. No Terminal,
          ZIP, API key, or second usage sharer.
        </p>

        {/* Download card — dark glass over the video (matches the landing page's
            bg-black/70 pattern). The light-mode `glass` class would render a near-
            white card that clashes with the cinematic video; dark glass integrates. */}
        <div className="mt-10 w-full max-w-md rounded-3xl border border-white/15 bg-black/70 p-6 text-left shadow-2xl backdrop-blur-xl">
          {/* Windows */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="grid size-11 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-primary/25">
                <Monitor className="size-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-white">Windows</span>
                  <span className="rounded-full bg-success/20 px-2 py-0.5 text-[10px] font-medium text-success">
                    Recommended
                  </span>
                </div>
                <div className="text-xs text-white/60">{metadata}</div>
              </div>
            </div>
            <Button asChild size="sm" className="w-full gap-2 sm:w-auto">
              <a href={release.downloadUrl} download>
                <Download className="size-4" /> Download free
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
            { icon: Activity, text: "Claude, Codex & Z.AI limits in one live dashboard" },
            { icon: Bell, text: "Automatic updates keep every new feature current" },
            { icon: TerminalSquare, text: "No Terminal, ZIP, API key, or second sharer" },
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
