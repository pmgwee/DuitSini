"use client";

import { useEffect, useRef } from "react";

/**
 * Fullscreen background video for the landing hero.
 *
 * iPadOS Safari is the reason this exists as its own client component:
 *  - React renders the `muted` *attribute*, but doesn't reliably set the DOM
 *    `muted` *property* on iOS/iPadOS, so Safari can treat the clip as unmuted
 *    and block autoplay → the element sits "paused". We set the property
 *    imperatively here and call play() in the same tick.
 *  - Low Power Mode / Data Saver blocks autoplay until a user gesture, so we
 *    also start playback on the first interaction anywhere on the page.
 */
export function HeroVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;

    // Force the DOM property (the attribute alone is unreliable on iOS/iPadOS).
    v.muted = true;
    v.defaultMuted = true;

    const tryPlay = () => {
      const p = v.play();
      if (p && typeof p.then === "function") p.catch(() => {});
    };
    tryPlay();

    // First-gesture fallback for Low Power Mode / Data Saver on iPadOS.
    const onGesture = () => tryPlay();
    window.addEventListener("pointerdown", onGesture, { once: true });
    window.addEventListener("touchend", onGesture, { once: true });
    window.addEventListener("keydown", onGesture, { once: true });

    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("touchend", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);

  return (
    <video
      ref={ref}
      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
      src={src}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
