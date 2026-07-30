import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_URL } from "./config";
import { Scheduler, type Status } from "./scheduler";
import { Store } from "./store";
import { TokenHolder } from "./mint";
import { startLoopback, type LoopbackHandle } from "./loopback";
import { createUsageTracker } from "./tracker";
import * as updater from "./updater";
import { ipcMain } from "electron";
import {
  DEEP_LINK_CALLBACK,
  DEEP_LINK_SCHEME,
  completionUrl,
  deepLinkFromArgv,
  isOAuthAuthorize,
  parseCallback,
  toDesktopAuthorizeUrl,
  type CallbackParams,
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
console.log(
  `[duitsini] boot version=${app.getVersion()} defaultApp=${process.defaultApp} platform=${process.platform} packaged=${app.isPackaged}`,
);
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let scheduler: Scheduler | null = null;
let quitting = false;
let lastStatus: Status = { kind: "idle" };
/** Tracks which update version we've already toasted, so we balloon once each. */
let balloonShownFor: string | null = null;

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
 * Forensic usage journal. Captures every usage/refresh event (real token
 * expiry, call count, 429/401 headers, refresh outcome) so a future stoppage is
 * diagnosable from data. The decisive failures also mirror to the console.
 */
const usageTracker = createUsageTracker(
  join(app.getPath("userData"), "usage-tracker.jsonl"),
  (line) => console.log(line),
);

/**
 * Where the provider hands the one-time code back to this app.
 *
 * Primary: the loopback HTTP listener — a fetchable http://127.0.0.1:{port} URL
 * the system browser navigates to directly, which sidesteps the custom-scheme
 * external-protocol dispatch that Chrome throttles for server-redirect triggers.
 * Fallback: the `duitsini://` deep link (kept registered below) for the rare
 * case the listener cannot bind.
 */
let loopback: LoopbackHandle | null = null;
function callbackTarget(): string {
  return loopback ? `${loopback.origin}/auth/callback` : DEEP_LINK_CALLBACK;
}

/**
 * Drop the persisted web cache when the desktop's own version changed since the
 * last launch (i.e. right after an update). The desktop loads the DEPLOYED web
 * app, and Electron reuses the previous deploy's cached shell across the shared
 * userData — so without this, an updated desktop renders the OLD web app until
 * the cache happens to expire. Cookies/localStorage are preserved (no re-login).
 */
async function clearWebCacheIfVersionChanged(): Promise<void> {
  const verFile = join(app.getPath("userData"), "last-launch-version");
  let lastVer = "";
  try {
    lastVer = readFileSync(verFile, "utf8").trim();
  } catch {
    /* first launch, or file missing — nothing to clear */
  }
  const curVer = app.getVersion();
  if (lastVer && lastVer !== curVer) {
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({
        storages: ["cachestorage", "serviceworkers"],
      });
      console.log(`[duitsini] version ${lastVer} → ${curVer}: cleared web cache for a fresh deploy load`);
    } catch (e) {
      console.log(`[duitsini] cache clear failed: ${(e as Error).message}`);
    }
  }
  try {
    writeFileSync(verFile, curVer, "utf8");
  } catch {
    /* non-fatal */
  }
}

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
      const external = toDesktopAuthorizeUrl(url, callbackTarget());
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
      void shell.openExternal(toDesktopAuthorizeUrl(url, callbackTarget()));
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

  // The scheduler's first tick usually races the initial window load and skips
  // its push ("app not ready"). Once the page is up the session cookie is in the
  // jar, so nudge one push on startup — covers the already-signed-in restart
  // case (a fresh login is already covered by completeSignIn's pullNow).
  win.webContents.once("did-finish-load", () => void scheduler?.pullNow());

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
    { label: "Open usage log", click: () => void shell.openPath(usageTracker.file) },
    {
      label: "Reload (bypass cache)",
      click: () => win?.webContents.reloadIgnoringCache(),
    },
    { type: "separator" },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    updateMenuItem(),
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

/**
 * Tray item reflects the updater state: a green badge + click-to-open-popup when
 * an update is available, a quiet "Check for updates" otherwise. Downloaded but
 * not-yet-restarted shows "Restart to update".
 */
function updateMenuItem(): MenuItemConstructorOptions {
  const s = updater.getState();
  if (s.kind === "available") {
    return {
      label: `🟢 Update available — v${s.version}`,
      click: () => openUpdatePopup(),
    };
  }
  if (s.kind === "downloaded") {
    return {
      label: `↻ Restart to update — v${s.version}`,
      click: () => updater.installAndRestart(),
    };
  }
  if (s.kind === "downloading") {
    return { label: `⬇ Updating… ${s.percent}%`, enabled: false };
  }
  if (s.kind === "checking") {
    return { label: "Checking for updates…", enabled: false };
  }
  return { label: "Check for updates", click: () => void updater.checkNow() };
}

/**
 * The update popup — a small window loading <APP_URL>/desktop-update with its
 * OWN preload (preload-update.ts) that exposes only the update bridge. The main
 * window's preload is untouched.
 */
function openUpdatePopup(): void {
  const s = updater.getState();
  if (s.kind !== "available") return;
  const updateWin = new BrowserWindow({
    width: 520,
    height: 640,
    resizable: false,
    minimizable: false,
    title: "Update DuitSini",
    backgroundColor: "#0b0b0f",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload-update.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  updater.attachPopup(updateWin);
  updateWin.on("closed", () => updater.attachPopup(null));
  const url = `${APP_URL}/desktop-update?from=${updater.currentVersion()}&to=${encodeURIComponent(s.version)}`;
  void updateWin.loadURL(url);
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
    tracker: usageTracker,
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
 * Claim `duitsini://` with the OS — the FALLBACK transport (loopback is
 * primary). Kept registered and hardened so the deep link still works if the
 * loopback listener cannot bind, and so packaged builds get an installer-grade
 * claim when paired with electron-builder `protocols`.
 *
 * Remove-then-set clears stale entries from a moved folder, a changed cwd, or a
 * shadowing packaged install (Win8+ UserChoice layer). In dev, `app.getAppPath()`
 * is the stable absolute app dir — `resolve(process.argv[1])` would record the
 * fragile cwd (`.`). The trailing `--` is the CVE-2018-1000006 argv-injection
 * mitigation (GitHub Desktop's pattern): it makes the appended `%1` positional
 * so a hostile URL cannot inject Chromium switches.
 */
function registerProtocolClient(): void {
  app.removeAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  let ok: boolean;
  if (process.defaultApp) {
    ok = app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
      app.getAppPath(),
      "--",
    ]);
  } else {
    ok = app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
  console.log(
    `[duitsini] protocol register (${process.defaultApp ? "dev" : "packaged"}) ` +
      `ok=${ok} isRegistered=${app.isDefaultProtocolClient(DEEP_LINK_SCHEME)} ` +
      `execPath=${process.execPath}${process.defaultApp ? ` appPath=${app.getAppPath()}` : ""}`,
  );
}

/**
 * Finish sign-in with the code the browser just handed us.
 *
 * The code is NOT exchanged here — we hand it to the web app's own
 * `/auth/callback`, which pairs it with the PKCE verifier already in this
 * window's cookie jar and sets the session itself. Shared by both transports:
 * the loopback HTTP listener (primary) and the `duitsini://` deep link (fallback).
 */
function completeSignIn(params: CallbackParams, via: string): void {
  console.log(
    `[duitsini] ${via} received (code=${params.code ? "yes" : "no"}${params.error ? " error=yes" : ""})`,
  );
  if (!win) createWindow();
  if (!win) return;
  // Pull focus back: the user just spent the round-trip in the system browser
  // and may have a tray-hidden or backgrounded window.
  app.focus({ steal: true });
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  // The web app's /auth/callback route redirects to /login?error=callback when
  // exchangeCodeForSession fails (rejected/expired code). That would otherwise
  // look identical to "stuck on login", so surface it once as a clear message.
  win.webContents.once("did-navigate", (_event, url) => {
    try {
      const u = new URL(url);
      if (u.pathname === "/login" && u.searchParams.get("error") === "callback") {
        console.log("[duitsini] session exchange FAILED → /login?error=callback");
        if (win && !win.isDestroyed()) {
          void dialog.showMessageBox(win, {
            type: "warning",
            title: "DuitSini",
            message: "Sign-in could not be completed.",
            detail: "The one-time code was rejected by the server. Please click Continue with Google again.",
          });
        }
      } else if (u.pathname === "/subscriptions" || u.pathname === "/") {
        console.log(`[duitsini] signed in → ${u.pathname}; pushing usage now`);
        // Fresh session just landed — push immediately instead of waiting up to
        // a full cadence cycle, so usage appears on the dashboard right away.
        // NOTE: the bridge token is intentionally kept cached here. An earlier
        // attempt invalidated it on each sign-in to handle Google-account
        // switching, but the re-mint raced the still-loading page and left usage
        // blank, so it was removed — reliability beats the rare switch case.
        void scheduler?.pullNow();
      }
    } catch {
      /* a non-url commit — ignore */
    }
  });

  void win.loadURL(completionUrl(appOrigin, params));
}

/** `duitsini://` deep-link fallback path. */
function handleDeepLink(link: string): void {
  if (isDev) console.log(`[duitsini] deep link raw: ${link}`);
  const params = parseCallback(link);
  if (!params) {
    console.log("[duitsini] deep link unparseable or missing code/error");
    return;
  }
  completeSignIn(params, "deep link");
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
    const link = deepLinkFromArgv(argv);
    console.log(`[duitsini] second-instance deep link: ${link ? "yes" : "no"}`);
    if (win) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    if (link) handleDeepLink(link);
  });

  // macOS delivers it as an event instead.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    console.log(`[duitsini] open-url: ${url}`);
    handleDeepLink(url);
  });

  void app.whenReady().then(async () => {
    // Bind the loopback listener first so callbackTarget() is resolved before
    // the window loads and before any sign-in can happen.
    loopback = await startLoopback((params) => completeSignIn(params, "loopback"));
    console.log(
      `[duitsini] loopback ${loopback ? loopback.origin : "FAILED — OAuth falls back to duitsini://"}`,
    );

    // If the desktop was just updated, the window's persisted web cache still
    // holds the PREVIOUS deploy's shell and would render stale UI (deployed
    // changes "not reflected"). Clear it — cookies/localStorage stay, so the
    // user keeps their session; only the HTTP/service-worker caches are dropped.
    await clearWebCacheIfVersionChanged();

    createWindow();
    createTray();

    // Cold start: the OS launched us BECAUSE of the deep link, so it is in our
    // own argv rather than arriving via second-instance.
    const initial = deepLinkFromArgv(process.argv);
    console.log(`[duitsini] cold-start deep link: ${initial ? "yes" : "no"}`);
    if (initial) handleDeepLink(initial);

    await startCollection();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else win?.show();
    });

    if (app.isPackaged) {
      // electron-updater can only run from a packaged build (it reads
      // app-update.yml baked in at build time). The user stays in control:
      // nothing downloads until they click "Update to vX" in the popup.
      await updater.init((line) => {
        if (isDev) console.log(`[duitsini] ${line}`);
      });
      // Rebuild the tray menu the moment an update is detected, AND fire a
      // Windows toast so the update can't hide in the right-click menu (the tray
      // icon itself doesn't visibly change). One toast per version; clicking it
      // opens the update popup.
      updater.onState((s) => {
        buildTrayMenu();
        if (
          s.kind === "available" &&
          balloonShownFor !== s.version &&
          tray &&
          !tray.isDestroyed()
        ) {
          balloonShownFor = s.version;
          tray.displayBalloon({
            iconType: "info",
            title: "DuitSini update available",
            content: `v${s.version} is ready — click to update.`,
          });
        }
      });
      tray?.on("balloon-click", () => {
        if (updater.getState().kind === "available") openUpdatePopup();
      });
      void updater.checkNow();
    }
  });
}

/**
 * IPC handlers for the update popup bridge (preload-update.ts).
 * Registered once at module load; the popup calls them via contextBridge.
 */
ipcMain.on("duitsini:update-info", (event) => {
  const s = updater.getState();
  const info =
    s.kind === "available" || s.kind === "downloaded"
      ? {
          currentVersion: updater.currentVersion(),
          newVersion: s.version,
          releaseUrl:
            "releaseUrl" in s && s.releaseUrl
              ? s.releaseUrl
              : "https://github.com/pmgwee/DuitSini/releases/latest",
        }
      : null;
  event.returnValue = info;
});
ipcMain.on("duitsini:update-start", () => void updater.startDownload());
ipcMain.on("duitsini:update-install", () => updater.installAndRestart());
// In-app header update badge: the renderer polls the live updater state and, on
// click, opens the same popup the tray uses. Polling (not a broadcast) keeps the
// wiring robust to renderer reloads/navigation.
ipcMain.handle("duitsini:update-state:get", () => updater.getState());
ipcMain.on("duitsini:update-open-popup", () => openUpdatePopup());

// Tray app: closing every window must not quit on Windows/Linux either.
app.on("window-all-closed", () => {
  // intentionally empty — quit happens via the tray's Quit item
});

app.on("before-quit", () => {
  quitting = true;
  scheduler?.stop();
  loopback?.close();
  void store.save();
});
