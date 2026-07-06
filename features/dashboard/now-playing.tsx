"use client";

import { useEffect, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, Music4 } from "lucide-react";

/**
 * Provider-agnostic playback surface. A real integration (YouTube Music, etc.)
 * implements this; until then `mockTracks` + local state stand in. The blueprint
 * calls out that direct playback control isn't realistic without a companion
 * service, so this is an explicit mock with a safe fallback.
 */
interface Track {
  title: string;
  artist: string;
  album: string;
  /** Two oklch stops for the generated album-art gradient. */
  gradient: [string, string];
  durationSec: number;
}

const mockTracks: Track[] = [
  {
    title: "Midnight City",
    artist: "M83",
    album: "Hurry Up, We're Dreaming",
    gradient: ["oklch(0.62 0.19 290)", "oklch(0.5 0.2 330)"],
    durationSec: 244,
  },
  {
    title: "Redbone",
    artist: "Childish Gambino",
    album: "Awaken, My Love!",
    gradient: ["oklch(0.55 0.18 25)", "oklch(0.5 0.16 350)"],
    durationSec: 326,
  },
  {
    title: "Strobe",
    artist: "deadmau5",
    album: "For Lack of a Better Name",
    gradient: ["oklch(0.6 0.16 230)", "oklch(0.45 0.18 260)"],
    durationSec: 634,
  },
];

export function NowPlaying() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0); // seconds, mock progress

  const track = mockTracks[index];

  // Mock playback: advance the progress bar while "playing".
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setPosition((p) => p + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);

  // Auto-advance when the mock position reaches the track's duration.
  useEffect(() => {
    if (playing && position >= track.durationSec) {
      setIndex((i) => (i + 1) % mockTracks.length);
      setPosition(0);
    }
  }, [position, playing, track.durationSec]);

  const changeTrack = (delta: number) => {
    setIndex((i) => (i + delta + mockTracks.length) % mockTracks.length);
    setPosition(0);
  };

  return (
    <div className="flex h-full flex-col gap-4 rounded-2xl border border-border/60 bg-surface/40 p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Music4 className="size-4 text-primary" /> Now playing
      </div>

      <div className="flex flex-1 items-center gap-4">
        {/* Album art */}
        <div
          className="grid size-20 shrink-0 place-items-center rounded-xl text-white/80 shadow-lg sm:size-24"
          style={{
            background: `linear-gradient(135deg, ${track.gradient[0]}, ${track.gradient[1]})`,
          }}
        >
          <Music4 className="size-7 opacity-70" />
        </div>

        {/* Track meta */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{track.title}</div>
          <div className="truncate text-sm text-muted-foreground">{track.artist}</div>
          <div className="truncate text-xs text-muted-foreground/70">{track.album}</div>
        </div>
      </div>

      {/* Progress */}
      <div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={track.durationSec}
          aria-valuenow={Math.floor(position)}
          aria-label={`${track.title} progress`}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear"
            style={{ width: `${(position / track.durationSec) * 100}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{formatTime(position)}</span>
          <span>{formatTime(track.durationSec)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          aria-label="Previous track"
          onClick={() => changeTrack(-1)}
          className="grid size-11 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SkipBack className="size-5" />
        </button>
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlaying((p) => !p)}
          className="grid size-12 place-items-center rounded-full bg-primary text-primary-foreground card-elevated transition-transform hover:brightness-110 active:scale-95"
        >
          {playing ? <Pause className="size-5" /> : <Play className="size-5 translate-x-0.5" />}
        </button>
        <button
          type="button"
          aria-label="Next track"
          onClick={() => changeTrack(1)}
          className="grid size-11 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <SkipForward className="size-5" />
        </button>
      </div>

      <p className="text-center text-[11px] text-muted-foreground/70">
        Demo playback · connect a music source for real control
      </p>
    </div>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
