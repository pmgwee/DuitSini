"use client";

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { MusicTrack } from "@/types/music";
import { useYTPlayer } from "./use-yt-player";

/** Everything the player exposes, shared across pages via context. */
export type MusicPlayerApi = ReturnType<typeof useYTPlayer>;

const MusicPlayerContext = createContext<MusicPlayerApi | null>(null);

/**
 * Mounts the YouTube player ONCE, at the app-shell level, so it survives route
 * changes. The IFrame lives inside a single fixed-position "portal" that is
 * NEVER unmounted or reparented — moving an iframe in the DOM reloads it, which
 * would restart the video and kill the Player API link. Instead the portal is
 * glued over the dashboard Music card's slot when docked, and parked off-screen
 * (still playing) elsewhere. Also owns play-logging: a track started from any
 * page is recorded to "Listen again", not only when the dashboard is open.
 */
export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  // The one and only home for the live iframe. Fixed-position; its coordinates
  // are driven imperatively by the hook (docked over the card, or off-screen).
  const portalRef = useRef<HTMLDivElement | null>(null);

  /**
   * Record the play — and DO NOT refresh the shelf.
   *
   * This used to invalidate the "listen again" query, so starting a track
   * rebuilt the whole list underneath the listener: the row they were about to
   * play next simply vanished. Recording feedback and recomputing
   * recommendations are separate concerns, and every incumbent keeps them
   * separate. Spotify's recommendations are a batch pipeline, not a live
   * request; a Daily Mix opened again within 8 hours is explicitly NOT
   * remixed, and their own API docs state listening history "will not update
   * in real time". A shelf that does not move under your feet is the feature,
   * not a limitation — see the refresh policy in `music-widget.tsx`.
   */
  const logPlay = useMemo(
    () => (track: MusicTrack) => {
      void fetch("/api/yt/plays", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(track),
      }).catch(() => {
        /* best-effort logging; never block playback */
      });
    },
    [],
  );

  const player = useYTPlayer(logPlay, portalRef);

  return (
    <MusicPlayerContext.Provider value={player}>
      {children}
      {/* The persistent iframe portal. Starts off-screen; the hook positions it
          over the dashboard slot (docked) or parks it (audio-only). Kept laid
          out — never display:none — so the browser never pauses the media. */}
      <div
        ref={portalRef}
        aria-hidden="true"
        className="yt-video-portal fixed left-[-10000px] top-0 z-20 h-[180px] w-[320px] overflow-hidden bg-black opacity-0"
      />
    </MusicPlayerContext.Provider>
  );
}

/** Access the shared player. Must be used inside <MusicPlayerProvider>. */
export function useMusicPlayer(): MusicPlayerApi {
  const ctx = useContext(MusicPlayerContext);
  if (!ctx) throw new Error("useMusicPlayer must be used within a MusicPlayerProvider");
  return ctx;
}
