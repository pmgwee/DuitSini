"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type State = "idle" | "loading" | "done";

/**
 * A slim top progress bar that gives INSTANT feedback the moment a navigation
 * begins — the fix for "did my click even register?" during App Router's
 * server round-trip. `NavProgress.start()` is called from nav links on click
 * (before the route resolves); the bar creeps toward ~90%. When `usePathname`
 * changes (the new route has committed), it snaps to 100% and fades.
 *
 * A global event bus (window CustomEvent) lets any link trigger it without
 * prop-drilling, and a safety timeout clears a stuck bar if a navigation is
 * cancelled (e.g. the user clicks the current route).
 */
const START_EVENT = "route-progress:start";

/** Fire from anywhere (nav links) to begin the bar. */
export function startRouteProgress() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(START_EVENT));
  }
}

export function RouteProgress() {
  const pathname = usePathname();
  const [state, setState] = useState<State>("idle");
  const doneTimer = useRef<number | undefined>(undefined);
  const safetyTimer = useRef<number | undefined>(undefined);
  const activePath = useRef(pathname);

  // Begin loading when a link signals a navigation start.
  useEffect(() => {
    const onStart = () => {
      window.clearTimeout(doneTimer.current);
      window.clearTimeout(safetyTimer.current);
      setState("loading");
      // Safety net: if the route never changes (cancelled nav / same route),
      // clear the bar so it doesn't hang.
      safetyTimer.current = window.setTimeout(() => setState("idle"), 8000);
    };
    window.addEventListener(START_EVENT, onStart);
    return () => window.removeEventListener(START_EVENT, onStart);
  }, []);

  // Complete when the committed pathname actually changes.
  useEffect(() => {
    if (pathname === activePath.current) return;
    activePath.current = pathname;
    window.clearTimeout(safetyTimer.current);
    setState((s) => (s === "loading" ? "done" : s));
    doneTimer.current = window.setTimeout(() => setState("idle"), 500);
    return () => window.clearTimeout(doneTimer.current);
  }, [pathname]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5"
    >
      <div data-state={state} className="route-bar h-full w-full rounded-r-full" />
    </div>
  );
}
