import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload — runs in an ISOLATED world with `contextIsolation: true`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE RUNS IN THE RENDERER PROCESS. Main-process-only modules — `app`,
 * `BrowserWindow`, `dialog`, `session`, `Tray`, … — are NOT available here;
 * `require("electron").app` is `undefined`, so touching it throws a TypeError.
 *
 * A throw anywhere in this file aborts the ENTIRE preload: every statement below
 * the throw is skipped, including the mint listener. The app then looks alive
 * (the window loads fine) while usage silently never pushes — the main process
 * only ever sees "mint timed out", and Electron does not print preload errors to
 * stdout. That exact bug shipped in v1.1.1 and broke usage tracking, the version
 * badge and the update badge in one line (`app.getVersion()`).
 *
 * Two rules keep it from happening again:
 *   1. Need something only the main process knows? Get it via `additionalArguments`
 *      (see `--duitsini-version` below) or IPC — never by importing a main module.
 *   2. The mint listener is registered FIRST, and every cosmetic exposure is
 *      individually guarded, so a broken nicety can never take usage down again.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The bridge's one real job is minting. `/api/bridge/mac-command` is guarded by a
 * `Sec-Fetch-Site` CSRF check and authenticated by the Supabase session cookie,
 * so the request has to be a genuine same-origin fetch from the signed-in
 * document. Issuing it from here satisfies both naturally — the browser sets
 * `Sec-Fetch-Site: same-origin` itself and attaches cookies — with no header
 * spoofing and no change to the route.
 */

// ─── 1. CRITICAL PATH FIRST ─────────────────────────────────────────────────
// Usage tracking depends on this listener existing. Nothing that can throw is
// allowed to run before it.

const TOKEN_RE = /cub_[0-9a-f]{48}/;

ipcRenderer.on("duitsini:mint", async (_event, requestId: string) => {
  try {
    const r = await fetch("/api/bridge/mac-command", {
      credentials: "include",
      cache: "no-store",
    });

    if (r.status === 401) {
      ipcRenderer.send("duitsini:mint-result", requestId, {
        ok: false,
        reason: "signed-out",
      });
      return;
    }
    if (!r.ok) {
      ipcRenderer.send("duitsini:mint-result", requestId, {
        ok: false,
        reason: `mint failed (${r.status})`,
      });
      return;
    }

    const body = (await r.json()) as { command?: string; account?: string | null };
    const token = TOKEN_RE.exec(body.command ?? "")?.[0];
    if (!token) {
      ipcRenderer.send("duitsini:mint-result", requestId, {
        ok: false,
        reason: "no token in mint response",
      });
      return;
    }

    ipcRenderer.send("duitsini:mint-result", requestId, {
      ok: true,
      token,
      account: body.account ?? null,
    });
  } catch (e) {
    ipcRenderer.send("duitsini:mint-result", requestId, {
      ok: false,
      reason: (e as Error).message,
    });
  }
});

// ─── 2. PAGE-FACING SURFACE ─────────────────────────────────────────────────
// Each exposure is independently guarded: one failing must not cascade.

/**
 * Expose a global, isolating any failure to that one global.
 *
 * The value is passed as a THUNK, not a value — that is the whole point. The
 * original outage was `exposeInMainWorld("...", app.getVersion())`, where the
 * argument is evaluated at the CALL SITE, before this function runs; a
 * try/catch inside here would never have seen it. Building the value inside the
 * try is what actually contains the failure.
 */
function expose(key: string, build: () => unknown): void {
  try {
    contextBridge.exposeInMainWorld(key, build());
  } catch (e) {
    // Never rethrow — a failed nicety must not abort the preload.
    console.error(`[duitsini] preload: could not expose ${key}: ${(e as Error).message}`);
  }
}

/**
 * `window.isDuitSiniDesktop` — a single read-only boolean so the "Share your
 * Claude usage" card can render the auto-tracking desktop copy instead of the
 * .bat/Terminal script steps. It is NOT a capability (no IPC, no filesystem, no
 * shells) and contextBridge defines it non-configurable/non-writable, so page
 * script cannot spoof or remove it. Do not strip it — the card depends on it.
 */
expose("isDuitSiniDesktop", () => true);

/**
 * `window.duitsiniDesktopVersion` — the installed version, for the "vX.Y.Z"
 * footer badge. Handed in by the main process via `webPreferences.
 * additionalArguments` because `app.getVersion()` is unreachable from here.
 */
expose("duitsiniDesktopVersion", () => {
  const FLAG = "--duitsini-version=";
  return process.argv.find((a) => a.startsWith(FLAG))?.slice(FLAG.length) ?? null;
});

/**
 * `window.duitsiniUpdater` — powers the header "update available" badge. The
 * page polls `getState` (a request/response IPC, robust to renderer reloads) and
 * calls `openPopup`/`restart` on click. No capability beyond what the tray
 * already exposes; it is only the *surface* that's new.
 */
expose("duitsiniUpdater", () => ({
  getState: (): Promise<unknown> => ipcRenderer.invoke("duitsini:update-state:get"),
  openPopup: (): void => {
    ipcRenderer.send("duitsini:update-open-popup");
  },
  restart: (): void => {
    ipcRenderer.send("duitsini:update-install");
  },
}));

/**
 * `window.duitsiniClaudeRenewal` — one-click renewal of a dead Claude Pro
 * dedicated sign-in (F4). Present only in the desktop shell; the dashboard gates
 * the "Renew sign-in" button on its existence. No capability beyond spawning
 * the same official-CLI browser flow a terminal could.
 */
expose("duitsiniClaudeRenewal", () => ({
  renewSignin: (): Promise<{ ok: boolean; reason?: string; configDir?: string }> =>
    ipcRenderer.invoke("duitsini:renew-claude-signin"),
}));
