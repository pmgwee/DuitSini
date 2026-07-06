"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Music4, Pause, Play, Search } from "lucide-react";
import type { YTPlayer } from "@/types/youtube";
import { cn } from "@/lib/utils";
import type { YTSearchItem } from "@/app/api/yt/search/route";

const API_SRC = "https://www.youtube.com/iframe_api";

/** Load the IFrame API once and resolve when window.YT is available. */
function loadAPI(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return;
    if (window.YT?.Player) return resolve();
    if (!document.getElementById("yt-iframe-api")) {
      const tag = document.createElement("script");
      tag.id = "yt-iframe-api";
      tag.src = API_SRC;
      document.head.appendChild(tag);
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    // Poll fallback in case the global callback was already taken.
    const id = window.setInterval(() => {
      if (window.YT?.Player) {
        window.clearInterval(id);
        resolve();
      }
    }, 200);
  });
}

/**
 * Now-playing music via the official YouTube IFrame Player API + Data API v3
 * search. Plays public, embeddable YouTube tracks (incl. music videos and
 * "- Topic" Art Tracks). Not a sync with the viewer's YouTube Music account.
 * Non-embeddable results (error 101/150) auto-skip.
 */
export function YouTubePlayer() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<YTSearchItem[]>([]);
  const [searching, setSearching] = useState(false);

  const [current, setCurrent] = useState<YTSearchItem | null>(null);
  const [index, setIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  const targetRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const queueRef = useRef<YTSearchItem[]>([]);
  const indexRef = useRef(-1);

  useEffect(() => {
    queueRef.current = results;
  }, [results]);

  const playIndex = useCallback((i: number) => {
    const track = queueRef.current[i];
    const player = playerRef.current;
    if (!track || !player) return;
    indexRef.current = i;
    setIndex(i);
    setCurrent(track);
    player.loadVideoById(track.videoId);
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const next = indexRef.current + delta;
      if (next >= 0 && next < queueRef.current.length) playIndex(next);
    },
    [playIndex],
  );

  // Create the player once the IFrame API is ready.
  useEffect(() => {
    let cancelled = false;
    loadAPI().then(() => {
      if (cancelled || !window.YT || !targetRef.current) return;
      playerRef.current = new window.YT.Player(targetRef.current, {
        playerVars: {
          autoplay: 0,
          controls: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: () => {
            /* ready */
          },
          onStateChange: (e) => {
            const YT = window.YT!;
            if (e.data === YT.PlayerState.PLAYING) {
              setIsPlaying(true);
              setDuration(e.target.getDuration() || 0);
            } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
              setIsPlaying(e.data === YT.PlayerState.BUFFERING);
            } else if (e.data === YT.PlayerState.ENDED) {
              setIsPlaying(false);
              skip(1);
            }
          },
          onError: (e) => {
            // 101 / 150 = embedding not allowed by the rights holder → skip.
            if (e.data === 101 || e.data === 150) skip(1);
          },
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [skip]);

  // Poll playback position while playing.
  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p) return;
      setPosition(p.getCurrentTime() || 0);
      setDuration(p.getDuration() || 0);
    }, 1000);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    try {
      const r = await fetch(`/api/yt/search?q=${encodeURIComponent(q)}`);
      const json = (await r.json()) as {
        results?: YTSearchItem[];
        configured?: boolean;
        error?: string;
      };
      setConfigured(json.configured ?? false);
      setResults(json.results ?? []);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) p.pauseVideo();
    else p.playVideo();
  };

  const playFrom = (i: number) => {
    // Treat the current search results as the queue from the chosen track.
    queueRef.current = results;
    playIndex(i);
  };

  const pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div className="flex h-full flex-col gap-4 rounded-2xl border border-border/60 bg-surface/40 p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Music4 className="size-4 text-primary" /> Music
      </div>

      {configured === false ? (
        <div className="rounded-xl border border-warning/30 bg-warning/6 px-3 py-2 text-xs text-warning">
          Set <code className="font-mono">YOUTUBE_API_KEY</code> (server env) to enable search &amp;
          playback.
        </div>
      ) : null}

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search music"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search a song or artist…"
            className="h-10 w-full rounded-xl border border-border/60 bg-input/50 pl-9 pr-3 text-sm outline-none focus:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
        <button
          type="button"
          onClick={search}
          disabled={searching}
          className="rounded-xl border border-border/60 bg-surface-2 px-3 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          {searching ? "…" : "Search"}
        </button>
      </div>

      {/* Player surface (kept visible & unobstructed per YouTube ToS) */}
      <div className="overflow-hidden rounded-xl bg-black/60">
        <div className="aspect-video w-full">
          {/* The IFrame API replaces this div with the player. */}
          <div ref={targetRef} className="h-full w-full" />
        </div>
      </div>

      {/* Now playing + controls */}
      <div>
        <div className="min-h-[2.5rem]">
          {current ? (
            <>
              <div className="truncate text-sm font-medium">{current.title}</div>
              <div className="truncate text-xs text-muted-foreground">{current.channel}</div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">
              Search and play any public track — not your YouTube Music library.
            </div>
          )}
        </div>

        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
          <span>{formatTime(position)}</span>
          <span>{formatTime(duration)}</span>
        </div>

        <div className="mt-2 flex items-center justify-center gap-3">
          <button
            type="button"
            aria-label="Previous"
            onClick={() => skip(-1)}
            disabled={index <= 0}
            className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={togglePlay}
            className={cn(
              "grid size-12 place-items-center rounded-full bg-primary text-primary-foreground card-elevated transition-transform hover:brightness-110 active:scale-95",
              !current && "opacity-50",
            )}
          >
            {isPlaying ? <Pause className="size-5" /> : <Play className="size-5 translate-x-0.5" />}
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={() => skip(1)}
            disabled={index < 0 || index >= results.length - 1}
            className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ChevronRight className="size-5" />
          </button>
        </div>
      </div>

      {/* Results */}
      {results.length > 0 ? (
        <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto">
          {results.map((r, i) => (
            <li key={r.videoId}>
              <button
                type="button"
                onClick={() => playFrom(i)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent",
                  i === index && "bg-accent",
                )}
              >
                {r.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.thumbnail}
                    alt=""
                    className="size-10 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="grid size-10 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
                    <Music4 className="size-4" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{r.title}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{r.channel}</div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-center text-[11px] text-muted-foreground/70">
        Powered by YouTube · search &amp; play public tracks
      </p>
    </div>
  );
}

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
