"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { YTPlayer } from "@/types/youtube";
import type { MusicTrack } from "@/types/music";

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
 * Queue-driven YouTube IFrame player. The player is created lazily on the
 * first play — creating it with no video shows YouTube's "An error occurred"
 * screen. Non-playable tracks (embed blocked 101/150, removed 100, bad id
 * 2/5) auto-skip; ended tracks auto-advance.
 */
export function useYTPlayer(onTrackStart?: (track: MusicTrack) => void) {
  const [current, setCurrent] = useState<MusicTrack | null>(null);
  const [index, setIndex] = useState(-1);
  const [queueLength, setQueueLength] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);

  const mountRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const creatingRef = useRef<Promise<YTPlayer> | null>(null);
  const queueRef = useRef<MusicTrack[]>([]);
  const indexRef = useRef(-1);
  const loggedIdRef = useRef<string | null>(null);
  const onTrackStartRef = useRef(onTrackStart);
  onTrackStartRef.current = onTrackStart;

  const playIndex = useCallback((i: number) => {
    const track = queueRef.current[i];
    const player = playerRef.current;
    if (!track || !player) return;
    indexRef.current = i;
    setIndex(i);
    setCurrent(track);
    setPosition(0);
    player.loadVideoById(track.videoId);
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const next = indexRef.current + delta;
      if (next >= 0 && next < queueRef.current.length) playIndex(next);
    },
    [playIndex],
  );

  /** Create the player on demand, once. */
  const ensurePlayer = useCallback((): Promise<YTPlayer> => {
    if (playerRef.current) return Promise.resolve(playerRef.current);
    if (creatingRef.current) return creatingRef.current;

    creatingRef.current = loadAPI().then(
      () =>
        new Promise<YTPlayer>((resolve) => {
          const YT = window.YT!;
          const player: YTPlayer = new YT.Player(mountRef.current!, {
            playerVars: {
              autoplay: 0,
              controls: 1,
              playsinline: 1,
              rel: 0,
              modestbranding: 1,
            },
            events: {
              onReady: () => {
                playerRef.current = player;
                setPlayerReady(true);
                resolve(player);
              },
              onStateChange: (e) => {
                const state = window.YT!.PlayerState;
                if (e.data === state.PLAYING) {
                  setIsPlaying(true);
                  setDuration(e.target.getDuration() || 0);
                  // Log each loaded track once, on first real playback.
                  const track = queueRef.current[indexRef.current];
                  if (track && loggedIdRef.current !== track.videoId) {
                    loggedIdRef.current = track.videoId;
                    onTrackStartRef.current?.(track);
                  }
                } else if (e.data === state.PAUSED) {
                  setIsPlaying(false);
                } else if (e.data === state.BUFFERING) {
                  setIsPlaying(true);
                } else if (e.data === state.ENDED) {
                  setIsPlaying(false);
                  skip(1);
                }
              },
              onError: (e) => {
                // 2/5 invalid, 100 removed/private, 101/150 embed blocked.
                if ([2, 5, 100, 101, 150].includes(e.data)) skip(1);
              },
            },
          });
        }),
    );
    return creatingRef.current;
  }, [skip]);

  /** Replace the queue and start playing at `i`. */
  const playQueue = useCallback(
    async (tracks: MusicTrack[], i: number) => {
      queueRef.current = tracks;
      setQueueLength(tracks.length);
      await ensurePlayer();
      playIndex(i);
    },
    [ensurePlayer, playIndex],
  );

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) p.pauseVideo();
    else p.playVideo();
  }, [isPlaying]);

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

  return {
    mountRef,
    playerReady,
    current,
    isPlaying,
    position,
    duration,
    hasPrev: index > 0,
    hasNext: index >= 0 && index < queueLength - 1,
    playQueue,
    toggle,
    next: () => skip(1),
    prev: () => skip(-1),
  };
}
