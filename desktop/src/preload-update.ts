import { contextBridge, ipcRenderer } from "electron";

/**
 * Preload for the UPDATE POPUP window ONLY.
 *
 * The main window's `preload.ts` deliberately exposes nothing — the web app has
 * no idea it is in a shell. This is a DIFFERENT preload for a different window:
 * the small `/desktop-update` popup, which needs exactly one capability the page
 * cannot have on its own: telling the main process to download and apply an
 * update. It exposes nothing the page doesn't already need for that single job.
 *
 * The bridge surface is deliberately tiny and update-scoped — no filesystem, no
 * shells, no arbitrary IPC. Just: read update info, start the download, observe
 * progress, and restart.
 */

export interface UpdateInfo {
  currentVersion: string;
  newVersion: string;
  releaseUrl: string;
}

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

contextBridge.exposeInMainWorld("duitsiniDesktop", {
  /** The versions + release URL, populated before the popup loads. */
  getInfo: (): UpdateInfo | null => {
    const raw = ipcRenderer.sendSync("duitsini:update-info");
    return typeof raw === "object" && raw !== null ? (raw as UpdateInfo) : null;
  },
  /** User clicked "Update to vX" — kick off the download. */
  startDownload: (): void => {
    ipcRenderer.send("duitsini:update-start");
  },
  /** Subscribe to download progress (percent etc.). Returns an unsubscribe fn. */
  onProgress: (cb: (p: UpdateProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: UpdateProgress): void => cb(p);
    ipcRenderer.on("duitsini:update-progress", listener);
    return () => ipcRenderer.off("duitsini:update-progress", listener);
  },
  /** Subscribe to the "download finished, ready to restart" signal. */
  onDownloaded: (cb: (version: string) => void): (() => void) => {
    const listener = (_e: unknown, version: string): void => cb(version);
    ipcRenderer.on("duitsini:update-downloaded", listener);
    return () => ipcRenderer.off("duitsini:update-downloaded", listener);
  },
  /** User clicked "Restart to update" — quit, install, relaunch. */
  installAndRestart: (): void => {
    ipcRenderer.send("duitsini:update-install");
  },
});
