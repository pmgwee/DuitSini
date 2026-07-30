"use client";

import { useEffect, useState } from "react";

/**
 * Shows the installed DuitSini Desktop version (e.g. "v1.1.1") in the app
 * footer — but ONLY when the page is running inside the desktop shell, which
 * exposes `window.isDuitSiniDesktop` + `window.duitsiniDesktopVersion` via the
 * preload's contextBridge. In a plain browser both are undefined → renders
 * nothing, so the footer is unchanged there.
 *
 * Rendered client-side only (window guard), so it stays null during SSR.
 */
export function DesktopVersionBadge() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const w = window as unknown as { isDuitSiniDesktop?: boolean; duitsiniDesktopVersion?: string };
    if (w.isDuitSiniDesktop === true && typeof w.duitsiniDesktopVersion === "string") {
      setVersion(w.duitsiniDesktopVersion);
    }
  }, []);

  if (!version) return null;

  return (
    <>
      <span aria-hidden className="text-border/60">
        ·
      </span>
      <span className="tabular-nums">v{version}</span>
    </>
  );
}
