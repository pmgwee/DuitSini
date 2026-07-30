"use client";

import { useEffect, useState } from "react";
import { ArrowDownToLine, Loader2, RotateCcw } from "lucide-react";

/**
 * In-app "update available" badge for the desktop shell — sits in the header
 * (left of the theme toggle). Only renders when there's something to act on;
 * otherwise it's null, so a plain browser (no `window.duitsiniUpdater`) sees
 * nothing and the header is unchanged.
 *
 * The desktop exposes `window.duitsiniUpdater = { getState(), openPopup(),
 * restart() }` via the preload's contextBridge. The badge POLLS getState every
 * 5s (the updater state changes rarely; polling sidesteps any broadcast timing
 * across renderer reloads/navigation). Clicking opens the same update popup the
 * tray uses, or restarts once a download has landed.
 */

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "not-available" }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

interface DesktopUpdater {
  getState: () => Promise<UpdateState>;
  openPopup: () => void;
  restart: () => void;
}

function getUpdater(): DesktopUpdater | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { duitsiniUpdater?: DesktopUpdater }).duitsiniUpdater ?? null;
}

const ICON_BTN =
  "relative inline-flex size-9 items-center justify-center rounded-full text-foreground transition-colors hover:bg-accent";

export function UpdateHeaderBadge() {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    const u = getUpdater();
    if (!u) return; // plain browser, or an older desktop build without the bridge
    let active = true;
    const poll = async () => {
      try {
        const s = await u.getState();
        if (active) setState(s);
      } catch {
        /* updater unavailable — leave the badge hidden */
      }
    };
    void poll();
    const id = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (!state) return null;

  if (state.kind === "available") {
    return (
      <button
        type="button"
        onClick={() => getUpdater()?.openPopup()}
        title={`Update available — v${state.version}`}
        aria-label={`Update available — v${state.version}`}
        className={ICON_BTN}
      >
        <ArrowDownToLine className="size-4" />
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-success ring-2 ring-background" />
      </button>
    );
  }

  if (state.kind === "downloading") {
    return (
      <span
        title={`Updating… ${state.percent}%`}
        className="inline-flex size-9 items-center justify-center text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
      </span>
    );
  }

  if (state.kind === "downloaded") {
    return (
      <button
        type="button"
        onClick={() => getUpdater()?.restart()}
        title={`Restart to finish the update — v${state.version}`}
        aria-label={`Restart to finish the update — v${state.version}`}
        className={ICON_BTN}
      >
        <RotateCcw className="size-4" />
      </button>
    );
  }

  // idle / checking / not-available / error → nothing in the header (the tray
  // still carries the full state for those).
  return null;
}
