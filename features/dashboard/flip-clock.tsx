"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Fliqlo-style flip clock: large tabular white numerals on elevated cards with
 * a horizontal seam, each digit flap-flipping in when it changes. Renders a
 * stable placeholder on the server / first paint to avoid hydration mismatch,
 * then ticks each second. The visible digits are decorative (aria-hidden); the
 * container exposes the full time to assistive tech via role="timer".
 */
export function FlipClock({ className }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const hh = now ? String(now.getHours()).padStart(2, "0") : "——";
  const mm = now ? String(now.getMinutes()).padStart(2, "0") : "——";
  const label = now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "clock";
  const date = now
    ? now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })
    : " ";

  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-5 py-10", className)}>
      <div
        role="timer"
        aria-label={label}
        aria-live="off"
        className="flex items-center gap-2 sm:gap-3"
      >
        <FlipDigit value={hh[0]} />
        <FlipDigit value={hh[1]} />
        <Colon />
        <FlipDigit value={mm[0]} />
        <FlipDigit value={mm[1]} />
      </div>
      <div className="text-sm text-muted-foreground">{date}</div>
    </div>
  );
}

function FlipDigit({ value }: { value: string }) {
  return (
    <span
      aria-hidden="true"
      className="relative grid min-w-13 place-items-center rounded-xl bg-surface-2 px-3 py-3 ring-1 ring-inset ring-white/5 sm:min-w-18 sm:px-4 sm:py-4"
      style={{ perspective: "500px" }}
    >
      <span
        key={value}
        className="block font-mono text-6xl font-semibold tabular-nums text-foreground sm:text-7xl"
        style={{ animation: "flip-in 0.4s ease-out", transformOrigin: "50% 0%" }}
      >
        {value}
      </span>
      {/* the flap seam across the middle */}
      <span className="pointer-events-none absolute inset-x-2 top-1/2 h-px -translate-y-1/2 bg-background/80 sm:inset-x-3" />
    </span>
  );
}

function Colon() {
  return (
    <span
      aria-hidden="true"
      className="flex flex-col gap-2 pb-3 font-mono text-5xl font-semibold text-muted-foreground sm:text-6xl"
    >
      <span>:</span>
    </span>
  );
}
