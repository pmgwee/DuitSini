import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_URL } from "./config";
import { Scheduler, type Status } from "./scheduler";
import { Store } from "./store";
import { TokenHolder } from "./mint";
import {
  DEEP_LINK_SCHEME,
  completionUrl,
  deepLinkFromArgv,
  isOAuthAuthorize,
  parseCallback,
  toDesktopAuthorizeUrl,
} from "./oauth";

/**
 * DuitSini Desktop — a shell, not a port.
 *
 * The window loads the DEPLOYED web app. That single decision is what makes
 * every Vercel deploy appear here with no shell rebuild, and it is why not one
 * line of the web app had to change. All this process adds is the thing a
 * browser fundamentally cannot do: read local Claude/gateway credentials and
 * push usage — the job the downloadable sharer script does today.
 */

const isDev = !app.isPackaged;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let scheduler: Scheduler | null = null;
let quitting = false;
let lastStatus: Status = { kind: "idle" };

const store = new Store(Store.pathFor(app.getPath("userData")));
const tokens = new TokenHolder(() => win, appOriginOf());

function appOriginOf(): string {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return "https://duitsini.vercel.app";
  }
}

const appOrigin = appOriginOf();

/**
 * Hosts the shell may navigate to in-window. Everything else goes to the system
 * browser.
 *
 * Getting this set RIGHT matters more than it looks. Google sign-in is a
 * multi-hop redirect chain — app → accounts.google.com → the SUPABASE project's
 * /auth/v1/callback → back to the app. If any hop is missing here, that
 * navigation is cancelled and handed to the system browser, so the user
 * completes sign-in in Chrome while the Electron window sits on the login page
 * with no session. (That is exactly what happened when the Supabase host was
 * only allow-listed from an env var the main process never loads.)
 *
 * Matching is by host, with an explicit suffix list, so any Supabase project ref
 * works without configuration.
 */
const ALLOWED_HOSTS = new Set<string>([
  "accounts.google.com",
  "oauth2.googleapis.com",
  "accounts.youtube.com",
  "www.youtube.com",
  "youtube.com",
]);

const ALLOWED_HOST_SUFFIXES = [
  ".supabase.co", // Supabase Auth callback (any project ref)
  ".supabase.in",
  ".google.com", // Google's sign-in / consent hops
  ".googleusercontent.com",
];

/** Extra origins for local dev or a custom domain, comma-separated. */
for (const extra of (process.env.DUITSINI_EXTRA_ORIGINS || "").split(",")) {
  const trimmed = extra.trim();
  if (!trimmed) continue;
  try {
    ALLOWED_HOSTS.add(new URL(trimmed).host);
  } catch {
    /* ignore a malformed entry */
  }
}

try {
  ALLOWED_HOSTS.add(new URL(APP_URL).host);
} catch {
  /* appOrigin fallback already applied above */
}

function isAllowed(url: string): boolean {
  try {
    const { host, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    if (ALLOWED_HOSTS.has(host)) return true;
    return ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0f",
    show: false,
    autoHideMenuBar: true,
    title: "DuitSini",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs fetch + ipcRenderer; no Node is exposed to the page
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.once("ready-to-show", () => win?.show());

  win.webContents.on("will-navigate", (event, url) => {
    // Provider hand-off: Google will not serve its consent screen to an
    // embedded webview, so this one navigation goes to the real browser with
    // `redirect_to` pointed back at us. See oauth.ts for why this needs no
    // cookie surgery.
    if (isOAuthAuthorize(url)) {
      event.preventDefault();
      const external = toDesktopAuthorizeUrl(url);
      if (isDev) console.log(`[duitsini] OAuth → system browser: ${external}`);
      void shell.openExternal(external);
      return;
    }

    // Keep everything else on known hosts; send the rest outward. Logged in dev
    // because a wrongly-blocked hop looks like "sign-in silently failed" rather
    // than like a navigation problem.
    if (isAllowed(url)) return;
    if (isDev) console.log(`[duitsini] blocked in-window nav → ${url} (opening externally)`);
    event.preventDefault();
    void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Same hand-off as will-navigate, for flows that open OAuth in a popup
    // instead of redirecting in place.
    if (isOAuthAuthorize(url)) {
      void shell.openExternal(toDesktopAuthorizeUrl(url));
      return { action: "deny" };
    }
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Closing hides to tray — collection continues until the user quits.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win?.hide();
  });
  win.on("closed", () => {
    win = null;
  });

  void win.loadURL(APP_URL);
}

/**
 * Locate an asset in both layouts: unpacked dev (`desktop/assets`, three levels
 * up from `dist/desktop/src`) and packaged (`extraResources` → resourcesPath).
 */
function assetPath(name: string): string | null {
  const candidates = [
    join(process.resourcesPath ?? "", "assets", name),
    join(__dirname, "..", "..", "..", "assets", name),
  ];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

function trayIcon(): Electron.NativeImage {
  const file = assetPath("tray.png");
  if (file) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function statusLine(): string {
  switch (lastStatus.kind) {
    case "ok":
      return `Live${lastStatus.sourceLabel ? ` — ${lastStatus.sourceLabel}` : ""}`;
    case "estimate":
      return `Estimate — ${lastStatus.reason}`;
    case "paused":
      return `Paused until ${new Date(lastStatus.until).toLocaleTimeString()}`;
    case "error":
      return lastStatus.reason;
    default:
      return "Starting…";
  }
}

function buildTrayMenu(): void {
  if (!tray) return;
  const items: MenuItemConstructorOptions[] = [
    { label: statusLine(), enabled: false },
    { type: "separator" },
    { label: "Open DuitSini", click: () => (win ? (win.show(), win.focus()) : createWindow()) },
    { label: "Refresh usage now", click: () => void scheduler?.pullNow() },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`DuitSini — ${statusLine()}`);
}

function createTray(): void {
  try {
    tray = new Tray(trayIcon());
    tray.on("click", () => (win ? (win.isVisible() ? win.hide() : win.show()) : createWindow()));
    buildTrayMenu();
  } catch {
    // A missing tray must never be fatal — the window still works without it.
    tray = null;
  }
}

async function startCollection(): Promise<void> {
  const persisted = await store.load();
  tokens.hydrate(null, null);

  scheduler = new Scheduler({
    store,
    getToken: () => tokens.get(),
    ingestUrl: () => `${appOrigin}/api/claude-usage/ingest`,
    onStatus: (s) => {
      lastStatus = s;
      buildTrayMenu();
    },
    log: (line) => {
      if (isDev) console.log(`[duitsini] ${line}`);
    },
  });

  void persisted;
  await scheduler.start();
}

/**
 * Claim `duitsini://` with the OS so the browser can hand the auth code back.
 *
 * Unpackaged runs need the electron binary plus the script path, otherwise the
 * OS would try to launch `electron.exe` with no app and the link would appear
 * to do nothing.
 */
function registerProtocolClient(): void {
  if (process.defaultApp) {
    const script = process.argv[1];
    if (script) {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(script)]);
    }
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
}

/**
 * Finish sign-in with the code the browser just handed us.
 *
 * We do not exchange it here — we hand it to the web app's own
 * `/auth/callback`, which pairs it with the PKCE verifier already in this
 * window's cookie jar and sets the session itself.
 */
function handleDeepLink(link: string): void {
  const params = parseCallback(link);
  if (!params) return;
  if (isDev) console.log(`[duitsini] deep link received (code=${params.code ? "yes" : "no"})`);

  if (!win) createWindow();
  if (!win) return;
  if (!win.isVisible()) win.show();
  win.focus();
  void win.loadURL(completionUrl(appOrigin, params));
}

// Single instance: a second launch focuses the running window instead of
// starting a second collector against the same account.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerProtocolClient();

  // Windows/Linux: a deep link launches (or re-activates) the app with the URL
  // appended to argv, and the single-instance lock routes it to the running
  // instance rather than starting a second collector.
  app.on("second-instance", (_e, argv) => {
    if (win) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    const link = deepLinkFromArgv(argv);
    if (link) handleDeepLink(link);
  });

  // macOS delivers it as an event instead.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  void app.whenReady().then(async () => {
    createWindow();
    createTray();

    // Cold start: the OS launched us BECAUSE of the deep link, so it is in our
    // own argv rather than arriving via second-instance.
    const initial = deepLinkFromArgv(process.argv);
    if (initial) handleDeepLink(initial);

    await startCollection();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else win?.show();
    });

    if (app.isPackaged) {
      try {
        const { autoUpdater } = await import("electron-updater");
        autoUpdater.autoDownload = true;
        void autoUpdater.checkForUpdatesAndNotify();
      } catch {
        // No update feed configured yet — not fatal.
      }
    }
  });
}

// Tray app: closing every window must not quit on Windows/Linux either.
app.on("window-all-closed", () => {
  // intentionally empty — quit happens via the tray's Quit item
});

app.on("before-quit", () => {
  quitting = true;
  scheduler?.stop();
  void store.save();
});
