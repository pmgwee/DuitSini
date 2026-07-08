"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * Queue-driven YouTube IFrame player that persists across route changes.
 *
 * The iframe lives in ONE fixed-position "portal" that the provider mounts once
 * and NEVER unmounts or reparents — because moving an <iframe> in the DOM tree
 * forces the browser to reload it (restarting the video AND breaking the YT
 * Player API postMessage link, which is why the scrubber/play-pause used to go
 * dead after a dock/undock). Instead we keep the iframe in place and just move
 * the portal *visually*: on /dashboard we glue it over the Music card's video
 * slot (rect-tracked each frame) so it looks docked inline; elsewhere it parks
 * off-screen and keeps playing (audio), while the mini-bar shows a thumbnail.
 *
 * The player is created lazily on the first play, seeded with that video so
 * YouTube never renders its empty-player error screen. Non-playable tracks
 * (embed blocked 101/150, removed 100, bad id 2/5) auto-skip; ended tracks
 * auto-advance.
 *
 * @param portalRef the fixed container (rendered by the provider) the iframe
 *   is created inside and never leaves.
 */
export function useYTPlayer(
  onTrackStart?: (track: MusicTrack) => void,
  portalRef?: React.RefObject<HTMLDivElement | null>,
) {
  const [current, setCurrent] = useState<MusicTrack | null>(null);
  const [index, setIndex] = useState(-1);
  const [queueLength, setQueueLength] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [volume, setVolumeState] = useState(50);
  const [muted, setMuted] = useState(false);

  // Which on-screen slot the video is docked into (the dashboard card), or null
  // when there's no slot on this route (parked off-screen, audio-only).
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  const slotElRef = useRef<HTMLElement | null>(null);
  slotElRef.current = slotEl;

  // The stable "stage" div handed to `new YT.Player()`. Created once; the API
  // replaces it with an <iframe> that then lives inside the portal forever.
  const stageEl = useMemo<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    return document.createElement("div");
  }, []);

  const playerRef = useRef<YTPlayer | null>(null);
  const creatingRef = useRef<Promise<YTPlayer> | null>(null);
  const queueRef = useRef<MusicTrack[]>([]);
  const indexRef = useRef(-1);
  const loggedIdRef = useRef<string | null>(null);
  const onTrackStartRef = useRef(onTrackStart);
  onTrackStartRef.current = onTrackStart;

  // Latest volume/mute for use inside the once-created player callbacks.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  // Debounce timer for persisting volume to the server (one request per drag,
  // not one per pixel).
  const saveTimerRef = useRef<number | null>(null);
  // Whether the portal should be shown (a track is loaded) vs. hidden.
  const hasVideoRef = useRef(false);
  hasVideoRef.current = playerReady && current !== null;

  // Warm up the IFrame API on mount so the first play can create the player
  // within the click gesture — keeping autoplay allowed.
  useEffect(() => {
    void loadAPI();
  }, []);

  // Home the stage inside the fixed portal once. It (and the iframe the API
  // swaps in) never leaves — only the portal's CSS position changes.
  useEffect(() => {
    if (!stageEl || !portalRef?.current) return;
    if (stageEl.parentElement !== portalRef.current) {
      portalRef.current.appendChild(stageEl);
    }
  }, [stageEl, portalRef]);

  /** Push current volume/mute to the live player (no-op before it exists). */
  const applyVolume = useCallback((v: number, mute: boolean) => {
    const p = playerRef.current;
    if (!p) return;
    if (mute) p.mute();
    else {
      p.unMute();
      p.setVolume(v);
    }
  }, []);

  // Load the user's saved volume once on mount (default 50 until it arrives),
  // so their chosen level survives sessions and devices. The volume also lives
  // in React state for the life of the provider (which wraps the whole app
  // shell), so it never resets when crossing pages — only on a full reload,
  // which this fetch re-hydrates.
  useEffect(() => {
    let active = true;
    fetch("/api/yt/volume", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active || typeof d?.volume !== "number") return;
        setVolumeState(d.volume);
        applyVolume(d.volume, false);
      })
      .catch(() => {
        /* best-effort: stay at the 50 default */
      });
    return () => {
      active = false;
    };
  }, [applyVolume]);

  /**
   * Glue the fixed portal over the docked slot's rect (so the video looks
   * inline in the card), or park it off-screen when there's no slot. Never
   * touches the DOM tree — only inline styles — so the iframe is never reloaded.
   */
  const positionPortal = useCallback(() => {
    const portal = portalRef?.current;
    if (!portal) return;
    const slot = slotElRef.current;
    if (slot) {
      const r = slot.getBoundingClientRect();
      const show = hasVideoRef.current;
      portal.style.top = `${r.top}px`;
      portal.style.left = `${r.left}px`;
      portal.style.width = `${r.width}px`;
      portal.style.height = `${r.height}px`;
      portal.style.borderRadius = window.getComputedStyle(slot).borderRadius;
      portal.style.opacity = show ? "1" : "0";
      portal.style.pointerEvents = show ? "auto" : "none";
    } else {
      // Parked: kept at real size, off-screen, so playback never pauses.
      portal.style.top = "0px";
      portal.style.left = "-10000px";
      portal.style.width = "320px";
      portal.style.height = "180px";
      portal.style.opacity = "0";
      portal.style.pointerEvents = "none";
    }
  }, [portalRef]);

  // While docked, follow the slot every frame (covers scroll, resize, and
  // layout shifts). While parked, position once. Cheap: just sets styles.
  useEffect(() => {
    positionPortal();
    if (!slotEl) return;
    let raf = 0;
    const loop = () => {
      positionPortal();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [slotEl, positionPortal]);

  /** Dock the video into `el` (dashboard slot) or park it off-screen (null). */
  const registerSlot = useCallback((el: HTMLElement | null) => setSlotEl(el), []);

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

  /**
   * Create the player on demand, once. `firstVideoId` is loaded straight into
   * the constructor so YouTube never renders its sticky empty-player "An error
   * occurred" screen (which was why the first click failed before).
   */
  const ensurePlayer = useCallback(
    (firstVideoId?: string): Promise<YTPlayer> => {
      if (playerRef.current) return Promise.resolve(playerRef.current);
      if (creatingRef.current) return creatingRef.current;

      creatingRef.current = loadAPI().then(
        () =>
          new Promise<YTPlayer>((resolve) => {
            const YT = window.YT!;
            const player: YTPlayer = new YT.Player(stageEl!, {
              width: "100%",
              height: "100%",
              videoId: firstVideoId,
              playerVars: {
                autoplay: 1,
                controls: 1,
                playsinline: 1,
                rel: 0,
                modestbranding: 1,
              },
              events: {
                onReady: () => {
                  playerRef.current = player;
                  applyVolume(volumeRef.current, mutedRef.current);
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
    },
    [stageEl, applyVolume, skip],
  );

  /** Replace the queue and start playing at `i`. */
  const playQueue = useCallback(
    async (tracks: MusicTrack[], i: number) => {
      queueRef.current = tracks;
      setQueueLength(tracks.length);
      const track = tracks[i];
      const created = !playerRef.current && !creatingRef.current;
      // Seed the very first player with the target video so YouTube skips its
      // empty-player error screen. Later plays reuse the existing player.
      await ensurePlayer(track?.videoId);
      if (created && track) {
        // The constructor already loaded (and autoplays) this track — sync our
        // state so the UI reflects it without a redundant reload.
        indexRef.current = i;
        setIndex(i);
        setCurrent(track);
        setPosition(0);
        loggedIdRef.current = null;
      } else {
        playIndex(i);
      }
    },
    [ensurePlayer, playIndex],
  );

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) p.pauseVideo();
    else p.playVideo();
  }, [isPlaying]);

  /** Stop playback and clear the queue (hides the persistent mini-player). */
  const stop = useCallback(() => {
    const p = playerRef.current;
    if (p) p.stopVideo();
    queueRef.current = [];
    indexRef.current = -1;
    setQueueLength(0);
    setCurrent(null);
    setIsPlaying(false);
    setPosition(0);
  }, []);

  const setVolume = useCallback(
    (v: number) => {
      const clamped = Math.max(0, Math.min(100, Math.round(v)));
      setVolumeState(clamped);
      if (clamped === 0) {
        // Dragging to zero is treated as mute so the icon reflects silence.
        setMuted(true);
        applyVolume(0, true);
      } else {
        if (muted) setMuted(false);
        applyVolume(clamped, false);
      }
      // Persist (debounced) so the chosen level is recalled next session. The
      // value already lives in state for the life of the provider, so this only
      // needs to survive full reloads / other devices.
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void fetch("/api/yt/volume", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ volume: clamped }),
        }).catch(() => {
          /* best-effort persistence */
        });
      }, 500);
    },
    [applyVolume, muted],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      applyVolume(volumeRef.current, next);
      return next;
    });
  }, [applyVolume]);

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
    registerSlot,
    playerReady,
    current,
    isPlaying,
    position,
    duration,
    queueLength,
    volume,
    muted,
    hasPrev: index > 0,
    hasNext: index >= 0 && index < queueLength - 1,
    playQueue,
    toggle,
    next: () => skip(1),
    prev: () => skip(-1),
    stop,
    setVolume,
    toggleMute,
  };
}
