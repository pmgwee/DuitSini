import { app, type BrowserWindow } from "electron";
import { EventEmitter } from "node:events";

/**
 * Auto-update lifecycle, wrapping electron-updater's `autoUpdater`.
 *
 * The user is always in control: nothing downloads until they click "Update to
 * vX" in the popup, and nothing restarts until they click "Restart" after the
 * download lands. `autoDownload` and `autoInstallOnAppQuit` are both OFF.
 *
 * State flows one way:
 *   idle → (checkForUpdates) → available → (startDownload) → downloading
 *        → downloaded → (installAndRestart) → quits + relaunches
 *
 * The popup window subscribes to progress/downloaded events via the emitter;
 * `main.ts` subscribes to `state` to rebuild the tray badge.
 */

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; releaseUrl: string | null }
  | { kind: "not-available" }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(20);

let state: UpdateState = { kind: "idle" };
let popup: BrowserWindow | null = null;
/** Lazy import — electron-updater is only meaningful in a packaged build. */
let autoUpdater: import("electron-updater").AppUpdater | null = null;

function setState(next: UpdateState): void {
  state = next;
  emitter.emit("state", state);
}

export function onState(cb: (s: UpdateState) => void): () => void {
  emitter.on("state", cb);
  return () => emitter.off("state", cb);
}

export function getState(): UpdateState {
  return state;
}

/**
 * Has `init()` actually wired an updater?
 *
 * Callers must check this before counting a check as "spent": the window can be
 * shown (and fire its check trigger) before init resolves, and a no-op call that
 * still stamped the throttle clock would suppress the real startup check.
 */
export function isReady(): boolean {
  return autoUpdater !== null;
}

export function attachPopup(win: BrowserWindow | null): void {
  popup = win;
}

function emitProgress(p: UpdateProgress): void {
  emitter.emit("progress", p);
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send("duitsini:update-progress", p);
  }
}

function emitDownloaded(version: string): void {
  emitter.emit("downloaded", version);
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send("duitsini:update-downloaded", version);
  }
}

/** Wire the autoUpdater events. Safe to call once, packaged builds only. */
export async function init(log: (line: string) => void): Promise<void> {
  if (autoUpdater) return; // already wired
  try {
    /**
     * `electron-updater` is CommonJS and exposes `autoUpdater` as a LAZY GETTER.
     * Node's cjs-module-lexer cannot see getters, so the ESM namespace from
     * `await import()` has no `autoUpdater` key at all — `mod.autoUpdater` is
     * `undefined`, while `mod.default.autoUpdater` is the real object. Verified
     * by enumeration on Electron 43:
     *   mod.autoUpdater         -> undefined
     *   mod.default.autoUpdater -> object
     *
     * Reading the named export is what broke auto-update from v1.0.0 to v1.1.6:
     * the next line threw, `init()` rejected as an unhandled rejection, and the
     * startup check never ran — so no update was ever detected, and the badge,
     * toast and tray item had nothing to show. Take `.default` first, keep the
     * named export as a fallback in case a future release flips the shape.
     */
    const mod = (await import("electron-updater")) as unknown as {
      default?: { autoUpdater?: import("electron-updater").AppUpdater };
      autoUpdater?: import("electron-updater").AppUpdater;
    };
    autoUpdater = mod.default?.autoUpdater ?? mod.autoUpdater ?? null;
    if (!autoUpdater) {
      log("[updater] electron-updater loaded but exposes no autoUpdater — updates disabled");
      return;
    }
  } catch (e) {
    log(`[updater] electron-updater unavailable: ${(e as Error).message}`);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  /**
   * Let an UNPACKAGED run exercise the real update check (DUITSINI_UPDATER_DEV=1).
   *
   * Without this the updater could only ever be observed in a shipped build, so
   * "does the badge/toast actually fire?" was untestable before release — which
   * is how a startup-only check survived from v1.1.1 to v1.1.6 unnoticed. With
   * it, `dev-app-update.yml` supplies the feed and the whole chain (fetch →
   * compare → update-available → state → toast) can be verified locally.
   *
   * Download/install remain user-driven, so this only makes the CHECK reachable.
   */
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
    log("[updater] dev mode: forcing dev-app-update.yml feed");
  }

  autoUpdater.on("checking-for-update", () => {
    setState({ kind: "checking" });
    log("[updater] checking for updates…");
  });

  autoUpdater.on("update-available", (info) => {
    const releaseUrl = info.releaseNotes
      ? `https://github.com/pmgwee/DuitSini/releases/tag/v${info.version}`
      : null;
    setState({
      kind: "available",
      version: info.version ?? "unknown",
      releaseUrl: releaseUrl ?? `https://github.com/pmgwee/DuitSini/releases/latest`,
    });
    log(`[updater] update available: v${info.version}`);
  });

  autoUpdater.on("update-not-available", () => {
    setState({ kind: "not-available" });
    log("[updater] up to date");
  });

  autoUpdater.on("download-progress", (p) => {
    setState({ kind: "downloading", percent: Math.round(p.percent ?? 0) });
    emitProgress({
      percent: Math.round(p.percent ?? 0),
      transferred: p.transferred ?? 0,
      total: p.total ?? 0,
      bytesPerSecond: p.bytesPerSecond ?? 0,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    const v = info.version ?? "latest";
    setState({ kind: "downloaded", version: v });
    emitDownloaded(v);
    log(`[updater] update downloaded: v${v}`);
  });

  autoUpdater.on("error", (err) => {
    setState({ kind: "error", message: err?.message ?? "unknown error" });
    log(`[updater] error: ${err?.message ?? "unknown"}`);
  });

  log(`[updater] initialised (current v${app.getVersion()})`);
}

/** Manual / startup check. No-op if autoUpdater never loaded (dev). */
export async function checkNow(): Promise<void> {
  if (!autoUpdater) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    /* surfaced via the error event */
  }
}

/** Begin downloading the update the user accepted in the popup. */
export async function startDownload(): Promise<void> {
  if (!autoUpdater) return;
  try {
    await autoUpdater.downloadUpdate();
  } catch {
    /* surfaced via the error event */
  }
}

/** Quit, install the downloaded update, and relaunch. */
export function installAndRestart(): void {
  if (!autoUpdater) return;
  // setAppPathToExe + relaunch on the current cwd so the app comes back.
  app.relaunch();
  autoUpdater.quitAndInstall();
}

export function currentVersion(): string {
  return app.getVersion();
}
