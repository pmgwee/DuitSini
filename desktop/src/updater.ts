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
    const mod = await import("electron-updater");
    autoUpdater = mod.autoUpdater;
  } catch (e) {
    log(`[updater] electron-updater unavailable: ${(e as Error).message}`);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

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
