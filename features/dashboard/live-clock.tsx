"use client";

import { useEffect, useState } from "react";

/**
 * Interim live clock for the dashboard. Renders a stable placeholder on the
 * server / first client paint to avoid hydration mismatch, then ticks each
 * second. Will be upgraded to a true Fliqlo-style flip clock in Phase 5.
 */
export function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now
    ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "--:--";
  const date = now
    ? now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })
    : "";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-12">
      <div className="font-mono text-7xl font-semibold tabular-nums tracking-tight sm:text-8xl">
        {time}
      </div>
      <div className="text-sm text-muted-foreground">{date || " "}</div>
    </div>
  );
}
