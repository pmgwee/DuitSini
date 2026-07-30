import { app, contextBridge, ipcRenderer } from "electron";

/**
 * Preload — runs in an ISOLATED world with `contextIsolation: true`.
 *
 * It deliberately exposes NOTHING to the page. The web app is unmodified and has
 * no idea it is inside a shell, which is the whole point: nothing here can be
 * reached (or spoofed) by page script.
 *
 * Its one job is minting. `/api/bridge/mac-command` is guarded by a
 * `Sec-Fetch-Site` CSRF check and authenticated by the Supabase session cookie,
 * so the request has to be a genuine same-origin fetch from the signed-in
 * document. Issuing it from here satisfies both naturally — the browser sets
 * `Sec-Fetch-Site: same-origin` itself and attaches cookies — with no header
 * spoofing and no change to the route.
 *
 * ONE deliberate exception: `window.isDuitSiniDesktop`. It is a single read-only
 * boolean so the "Share your Claude usage" card can render the auto-tracking
 * desktop copy instead of the .bat/Terminal script steps. It is NOT a capability
 * (no IPC, no filesystem, no shells) and contextBridge defines it
 * non-configurable/non-writable, so page script cannot spoof or remove it. Do
 * not strip it — the card depends on it; do not add anything callable here.
 */
contextBridge.exposeInMainWorld("isDuitSiniDesktop", true);
// The installed desktop version (package.json version), so the in-app footer
// can show "vX.Y.Z" beside the legal links. Same non-spoofable guarantee as
// the boolean above.
contextBridge.exposeInMainWorld("duitsiniDesktopVersion", app.getVersion());

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
