"use client";

import { useEffect } from "react";
import { useToast } from "./toast-provider";

type RenewalCap = { onResult: (cb: (result: { ok: boolean }) => void) => () => void };

/**
 * Bridges the desktop's "Renew sign-in" outcome to the in-app toast. The
 * credential watcher in the main process fires the result over IPC when it
 * detects new creds (success) or gives up (timeout); this surfaces it through
 * the same toast provider the rest of the dashboard uses, so the user sees the
 * confirmation in-app even when the OS notification is suppressed.
 *
 * Desktop shell only — no-ops in a browser, where the capability isn't exposed.
 * Mounted once in the (app) layout so the toast lands wherever the user is when
 * a renew completes.
 */
export function DesktopRenewalToast() {
  const { showToast } = useToast();
  useEffect(() => {
    const cap = (window as unknown as { duitsiniClaudeRenewal?: RenewalCap }).duitsiniClaudeRenewal;
    if (!cap) return; // browser, or an older shell without the capability
    return cap.onResult((result) => {
      showToast(
        result.ok
          ? { message: "Claude Pro sign-in renewed — usage tracking has resumed." }
          : { message: "Claude sign-in didn't complete. Click Renew sign-in again." },
      );
    });
  }, [showToast]);
  return null;
}
