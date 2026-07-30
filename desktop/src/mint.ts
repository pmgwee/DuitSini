import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";

/**
 * Bridge-token acquisition, driven from the main process but executed in the
 * renderer's isolated world (see `preload.ts` for why).
 *
 * The token IS the identity — every push lands on the token owner's dashboard
 * row regardless of which Google account is signed in elsewhere on the machine.
 * That makes it personal data, so it is held in memory and in this app's own
 * userData state only, and is never written anywhere shareable.
 */

export type MintResult =
  | { ok: true; token: string; account: string | null }
  | { ok: false; reason: string };

const PENDING = new Map<string, (r: MintResult) => void>();
const MINT_TIMEOUT_MS = 15_000;

let listenerBound = false;

function bindListener(): void {
  if (listenerBound) return;
  listenerBound = true;
  ipcMain.on("duitsini:mint-result", (_e, requestId: string, result: MintResult) => {
    const resolve = PENDING.get(requestId);
    if (!resolve) return;
    PENDING.delete(requestId);
    resolve(result);
  });
}

/**
 * Ask the loaded page to mint a token on our behalf.
 *
 * `expectedOrigin` is a hard gate, not a formality. The navigation allow-list
 * necessarily admits every `*.supabase.co` project (we cannot know the ref
 * ahead of time), and the preload mints from a RELATIVE url — so if the window
 * happened to be sitting on a foreign origin we would be asking that origin for
 * a bridge token. Minting only ever happens while the app itself is loaded.
 */
export function requestMint(win: BrowserWindow, expectedOrigin: string): Promise<MintResult> {
  bindListener();
  return new Promise((resolve) => {
    if (win.isDestroyed() || win.webContents.isLoading()) {
      resolve({ ok: false, reason: "app not ready" });
      return;
    }
    let currentOrigin: string;
    try {
      currentOrigin = new URL(win.webContents.getURL()).origin;
    } catch {
      resolve({ ok: false, reason: "no page loaded" });
      return;
    }
    if (currentOrigin !== expectedOrigin) {
      resolve({ ok: false, reason: "not on the app origin" });
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      PENDING.delete(id);
      resolve({ ok: false, reason: "mint timed out" });
    }, MINT_TIMEOUT_MS);

    PENDING.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    win.webContents.send("duitsini:mint", id);
  });
}

/**
 * Caches the token across pushes and re-mints on demand.
 *
 * Minting inserts a NEW row and prunes the user's oldest beyond 10, so it must
 * not happen on every cycle — a chatty client would churn a member's tokens and
 * could prune one a still-running sharer depends on. We mint once, reuse, and
 * only re-mint when the server actually rejects what we hold.
 */
export class TokenHolder {
  private token: string | null = null;
  private account: string | null = null;
  private inflight: Promise<string | null> | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly appOrigin: string,
  ) {}

  get accountEmail(): string | null {
    return this.account;
  }

  hydrate(token: string | null, account: string | null): void {
    this.token = token;
    this.account = account;
  }

  current(): string | null {
    return this.token;
  }

  /** Drop the cached token so the next `get()` mints a fresh one. */
  invalidate(): void {
    this.token = null;
  }

  async get(): Promise<string | null> {
    if (this.token) return this.token;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const win = this.getWindow();
      if (!win) {
        console.log("[duitsini] mint: no window");
        return null;
      }
      const r = await requestMint(win, this.appOrigin);
      if (!r.ok) {
        // Surface the real reason — "app not ready" (window still loading), "not
        // on the app origin", "signed-out" (401), or "mint timed out" all look
        // identical from the scheduler's side without this.
        console.log(`[duitsini] mint failed: ${r.reason}`);
        return null;
      }
      this.token = r.token;
      this.account = r.account;
      console.log(`[duitsini] mint ok${r.account ? ` (${r.account})` : ""}`);
      return r.token;
    })();

    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}
