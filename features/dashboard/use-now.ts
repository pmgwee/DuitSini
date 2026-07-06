"use client";

import { useEffect, useState } from "react";

/**
 * A ticking `Date.now()` for live countdowns. Returns `null` on the server and
 * first client paint (so SSR output is stable → no hydration mismatch), then a
 * millisecond timestamp that updates every `intervalMs`.
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
