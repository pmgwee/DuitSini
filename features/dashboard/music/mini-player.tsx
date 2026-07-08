"use client";

import {
  ChevronLeft,
  ChevronRight,
  Music4,
  Pause,
  Play,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useMusicPlayer } from "./player-context";

/**
 * Floating "now playing" bar — shown on every app route EXCEPT /dashboard,
 * where the same live player is docked inline inside the Music card instead.
 * (Same concept as the YouTube mobile app: the video lives in-card while
 * you're there, and collapses to a thumbnail bar when you navigate away.)
 *
 * The bar shows a STATIC thumbnail (not the IFrame) — friendlier and lighter.
 * The real IFrame keeps playing, parked off-screen by the player provider.
 * Apple "Liquid Glass" treatment gives it the iOS 26 translucent, refracted look.
 */
export function MiniPlayer() {
  const p = useMusicPlayer();
  const pathname = usePathname();
  const onDashboard = pathname.startsWith("/dashboard");
  // Visible only while a queue exists AND we're away from the dashboard dock.
  const visible = p.queueLength > 0 && !onDashboard;
  const pct = p.duration > 0 ? Math.min(100, (p.position / p.duration) * 100) : 0;

  const VolIcon = p.muted || p.volume === 0 ? VolumeX : p.volume >= 50 ? Volume2 : Volume1;

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        // Anchored above the mobile bottom nav (bottom-14, ~nav height) up to
        // lg where the nav disappears; offset past the 248px sidebar on lg so
        // the bar lives in (and aligns with) the content column instead of
        // overlaying the navbar on iPad/desktop-width viewports.
        "fixed bottom-20 left-0 right-0 z-30 px-3 transition-all duration-300 ease-out sm:px-6 lg:bottom-3 lg:left-62",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-8 opacity-0",
      )}
    >
      <div className="liquid-glass mx-auto flex max-w-3xl items-center gap-2.5 rounded-2xl px-2.5 py-2 sm:gap-3 sm:px-3">
        {/* Static thumbnail (NOT the IFrame) */}
        <div className="relative size-11 shrink-0 overflow-hidden rounded-xl bg-black/60 sm:size-12">
          {p.current?.thumbnail ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.current.thumbnail} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full place-items-center text-muted-foreground">
              <Music4 className="size-4" />
            </div>
          )}
          {/* Equalizer pulse while playing */}
          <div
            className={cn(
              "absolute bottom-1 left-1 flex items-end gap-0.5 transition-opacity",
              p.isPlaying ? "opacity-100" : "opacity-0",
            )}
          >
            <span className="eq-bar h-2.5 w-0.5 rounded-full bg-white/90" />
            <span className="eq-bar h-2.5 w-0.5 rounded-full bg-white/90 [animation-delay:0.15s]" />
            <span className="eq-bar h-2.5 w-0.5 rounded-full bg-white/90 [animation-delay:0.3s]" />
          </div>
        </div>

        {/* Title + scrubber */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium leading-tight sm:text-sm">
            {p.current?.title ?? "—"}
          </div>
          <div className="truncate text-[11px] leading-tight text-muted-foreground">
            {p.current?.channel ?? ""}
          </div>
          <div className="mt-1 hidden items-center gap-2 sm:flex">
            <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">
              {formatTime(p.position)}
            </span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/15">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-8 text-[10px] tabular-nums text-muted-foreground">
              {formatTime(p.duration)}
            </span>
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex items-center gap-0.5 sm:gap-1">
          <button
            type="button"
            aria-label="Previous"
            onClick={p.prev}
            disabled={!p.hasPrev}
            className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            aria-label={p.isPlaying ? "Pause" : "Play"}
            onClick={p.toggle}
            className="grid size-10 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition-transform hover:brightness-110 active:scale-95"
          >
            {/* Optical centering: nudge the play triangle right a hair so it
                reads as dead-center inside the circle. Pause is symmetric. */}
            {p.isPlaying ? (
              <Pause className="size-4.5 fill-current" />
            ) : (
              <Play className="size-4.5 translate-x-px fill-current" />
            )}
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={p.next}
            disabled={!p.hasNext}
            className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>

        {/* Volume — sits to the right of the next button */}
        <div className="flex items-center gap-1 pl-0.5 sm:pl-1">
          <button
            type="button"
            aria-label={p.muted ? "Unmute" : "Mute"}
            onClick={p.toggleMute}
            className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <VolIcon className="size-4" />
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            aria-label="Volume"
            value={p.muted ? 0 : p.volume}
            onChange={(e) => p.setVolume(Number(e.target.value))}
            className="vol-slider h-1 w-12 cursor-pointer accent-primary sm:w-16"
          />
        </div>

        {/* Stop / clear — desktop only; mobile reaches the dashboard dock */}
        <button
          type="button"
          aria-label="Stop and clear"
          onClick={p.stop}
          className="hidden size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-danger sm:grid"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
