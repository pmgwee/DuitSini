import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
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
/** Tracks which update version we've already toasted, so we notify once each. */
let balloonShownFor: string | null = null;

/**
 * How often a RUNNING app re-checks for updates.
 *
 * A startup-only check is useless for this app: the window closes to the tray
 * rather than quitting, so a typical install runs for days. A release published
 * after launch was therefore never discovered — the update badge and the toast
 * had nothing to fire on, which looked exactly like "the badge is broken".
 */
const UPDATE_CHECK_MS = 30 * 60_000;
/** Floor between automatic checks, so window-show can't hammer the feed. */
const UPDATE_CHECK_MIN_GAP_MS = 5 * 60_000;
/**
 * Ceiling on a single check, matching cc-switch's 30s. electron-updater has no
 * timeout of its own, so a stalled feed request would otherwise leave the tray
 * stuck on "Checking for updates…" indefinitely with no way back.
 */
const UPDATE_CHECK_TIMEOUT_MS = 30_000;
let lastUpdateCheckAt = 0;
/** True in-flight guard. The time gap alone can't stop two bypassing triggers. */
let checkInFlight = false;

/**
 * Every update check goes through here so each one is throttled and journaled.
 * `manual` (the tray item) bypasses the gap — the user asked explicitly.
 */
/** Packaged builds, plus an explicit dev opt-in for verifying the feed locally. */
function updaterEnabled(): boolean {
  return app.isPackaged || process.env.DUITSINI_UPDATER_DEV === "1";
}

async function checkForUpdates(trigger: string): Promise<void> {
  if (!updaterEnabled()) return; // electron-updater needs a packaged build
  // Not yet wired: the window can be shown before init() resolves, and stamping
  // the throttle clock for a call that does nothing would suppress the real
  // startup check for the next 5 minutes.
  if (!updater.isReady()) return;
  const now = Date.now();
  // `startup` and `manual` always run — the gap exists to stop `window-show`
  // and the periodic timer from piling up, not to skip the first real check.
  const throttled = trigger !== "manual" && trigger !== "startup";
  if (throttled && now - lastUpdateCheckAt < UPDATE_CHECK_MIN_GAP_MS) return;
  // `startup` and `manual` skip the gap, so two of them can land together —
  // hence a real in-flight flag rather than relying on the clock alone.
  if (checkInFlight) return;
  checkInFlight = true;
  lastUpdateCheckAt = now;
  usageTracker.event("updater_check", { trigger, current: app.getVersion() });
  try {
    await Promise.race([
      updater.checkNow(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("update check timed out")), UPDATE_CHECK_TIMEOUT_MS),
      ),
    ]);
  } catch (e) {
    const message = (e as Error).message;
    console.error(`[duitsini] [updater] check failed: ${message}`);
    usageTracker.event("updater_check_failed", { trigger, message });
  } finally {
    checkInFlight = false;
  }
}

/**
 * Tell the user a new version exists.
 *
 * `tray.displayBalloon` is the legacy Windows path and is frequently swallowed
 * on Windows 10/11. Electron's `Notification` maps to a real toast when the app
 * has a Start-menu shortcut (the NSIS installer creates one) and an AppUserModelID
 * is set (see `setAppUserModelId` below), so prefer it and keep the balloon as a
 * fallback rather than the only route.
 */
function notifyUpdateAvailable(version: string): void {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "DuitSini update available",
        body: `v${version} is ready — click to update.`,
      });
      n.on("click", () => openUpdatePopup());
      n.show();
      usageTracker.event("updater_notify", { version, via: "notification" });
      return;
    }
  } catch (e) {
    usageTracker.event("updater_notify_error", { version, message: (e as Error).message });
  }
  if (tray && !tray.isDestroyed()) {
    tray.displayBalloon({
      iconType: "info",
      title: "DuitSini update available",
      content: `v${version} is ready — click to update.`,
    });
    usageTracker.event("updater_notify", { version, via: "balloon" });
  }
}

/**
 * Toast for the Renew sign-in outcome. Without it, a successful renew left the
 * dashboard on "Sign-in stale" until the next push and the user reasonably
 * concluded the login had failed. Fired the moment the credential watcher
 * confirms a new login, or when it gives up.
 */
function notifyRenewalResult(success: boolean): void {
  const body = success
    ? "Claude Pro sign-in renewed — usage tracking has resumed."
    : "Claude sign-in didn't complete. Click 'Renew sign-in' again.";
  // Surface to the in-app toast (the web app's toast provider) via the
  // renderer, so the user sees the result in the dashboard even when the OS
  // notification is suppressed by Windows / focus-assist.
  try {
    win?.webContents.send("duitsini:claude-renew-result", { ok: success });
  } catch {
    /* window may be closed */
  }
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: "DuitSini", body });
      n.on("click", () => (win ? (win.show(), win.focus()) : createWindow()));
      n.show();
      usageTracker.event("claude_renew_signin_notify", { result: success ? "success" : "timeout" });
    }
  } catch (e) {
    usageTracker.event("claude_renew_signin_notify_error", { message: (e as Error).message });
  }
}

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
      // The preload runs in the RENDERER process, where `electron.app` does not
      // exist — reading it there throws and aborts the whole preload (see the
      // header comment in preload.ts). So the version is handed over as an argv
      // flag instead: available synchronously, and impossible to get wrong.
      additionalArguments: [`--duitsini-version=${app.getVersion()}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs fetch + ipcRenderer; no Node is exposed to the page
      webSecurity: true,
      spellcheck: false,
    },
  });

  // A preload that throws takes the mint listener down with it and the only
  // symptom is "mint timed out" every cycle — Electron does NOT surface preload
  // errors on stdout. Log it loudly; this class of bug cost hours once already.
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(
      `[duitsini] PRELOAD FAILED (${preloadPath}): ${error.message}\n` +
        "[duitsini] usage push and the update badge are dead until this is fixed.",
    );
  });

  win.once("ready-to-show", () => win?.show());

  // Coming back to the window is the moment the user is most likely to act on
  // an update, and for a tray app it may be days after launch. Throttled inside
  // checkForUpdates, so re-showing repeatedly costs nothing.
  win.on("show", () => void checkForUpdates("window-show"));

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
    ...updateMenuItems(),
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
function updateMenuItems(): MenuItemConstructorOptions[] {
  const s = updater.getState();
  if (s.kind === "available") {
    const skipped = store.dismissedUpdateVersion() === s.version;
    return [
      { label: `🟢 Update available — v${s.version}`, click: () => openUpdatePopup() },
      // Declining an update must be expressible, or the only way to stop being
      // asked is to take it. Skipping silences the TOAST for this version only;
      // the item above stays, and a newer version notifies normally again.
      skipped
        ? { label: `Skipped v${s.version} — notify again`, click: () => setSkippedVersion(null) }
        : { label: `Skip v${s.version}`, click: () => setSkippedVersion(s.version) },
    ];
  }
  if (s.kind === "downloaded") {
    return [{ label: `↻ Restart to update — v${s.version}`, click: () => updater.installAndRestart() }];
  }
  if (s.kind === "downloading") {
    return [{ label: `⬇ Updating… ${s.percent}%`, enabled: false }];
  }
  if (s.kind === "checking") {
    return [{ label: "Checking for updates…", enabled: false }];
  }
  return [{ label: "Check for updates", click: () => void checkForUpdates("manual") }];
}

function setSkippedVersion(version: string | null): void {
  store.setDismissedUpdateVersion(version);
  void store.save();
  usageTracker.event("updater_skip", { version });
  buildTrayMenu();
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
    getGoogleCookies: async () => {
      try {
        const cookies = await session.defaultSession.cookies.get({ domain: ".google.com" });
        if (!cookies || cookies.length === 0) return null;
        const psid = cookies.find((c) => c.name === "__Secure-1PSID")?.value;
        const sid = cookies.find((c) => c.name === "SID")?.value;
        if (psid) {
          return `__Secure-1PSID=${psid}${sid ? `; SID=${sid}` : ""}`;
        }
        return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      } catch {
        return null;
      }
    },
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
    // Windows toasts are attributed by AppUserModelID. Without one matching the
    // installer's appId, `new Notification()` can be dropped silently — which is
    // precisely the "no toast appeared" symptom. Must match electron-builder.yml.
    if (process.platform === "win32") app.setAppUserModelId("com.duitsini.desktop");

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

    console.log(
      `[duitsini] updater gate: packaged=${app.isPackaged} devFlag=${process.env.DUITSINI_UPDATER_DEV ?? "unset"} enabled=${updaterEnabled()}`,
    );
    if (app.isPackaged || process.env.DUITSINI_UPDATER_DEV === "1") {
      // Normally packaged-only (electron-updater reads the baked-in
      // app-update.yml), but DUITSINI_UPDATER_DEV=1 points it at
      // dev-app-update.yml so the check can be verified without cutting a
      // release. The user stays in control either way: nothing downloads until
      // they click "Update to vX" in the popup.
      // NOT gated on isDev. A packaged build is the only place the updater ever
      // runs, so gating its log there left the feature with zero diagnostics —
      // which is why "no badge appeared" was impossible to tell apart from "no
      // update was found". Also journaled, so the user can read it from the tray
      // ("Open usage log") without launching from a terminal.
      // Guarded because `init()` is AWAITED inside app.whenReady(): a throw in
      // there becomes an unhandled rejection that silently abandons everything
      // below — the startup check, the periodic timer, the toast wiring. That is
      // precisely how auto-update stayed dead from v1.0.0 to v1.1.6 with no
      // visible error. A failed init must degrade to "no updates", never to
      // "half the startup sequence didn't run".
      try {
        await updater.init((line) => {
          console.log(`[duitsini] ${line}`);
          usageTracker.event("updater", { line });
        });
      } catch (e) {
        const message = (e as Error).message;
        console.error(`[duitsini] [updater] init FAILED: ${message}`);
        usageTracker.event("updater_init_failed", { message });
      }
      // Rebuild the tray menu the moment an update is detected, AND fire a
      // Windows toast so the update can't hide in the right-click menu (the tray
      // icon itself doesn't visibly change). One toast per version; clicking it
      // opens the update popup.
      updater.onState((s) => {
        buildTrayMenu();
        if (s.kind !== "available") return;
        if (balloonShownFor === s.version) return; // at most one toast per run
        // A version the user explicitly skipped never toasts again — the tray
        // item and header badge still show it, so the update is not hidden, just
        // no longer interruptive. (cc-switch's dismissedVersion, persisted.)
        if (store.dismissedUpdateVersion() === s.version) {
          usageTracker.event("updater_toast_skipped", { version: s.version });
          return;
        }
        balloonShownFor = s.version;
        notifyUpdateAvailable(s.version);
      });
      tray?.on("balloon-click", () => {
        if (updater.getState().kind === "available") openUpdatePopup();
      });

      void checkForUpdates("startup");
      // The check that actually matters: this app lives in the tray for days at
      // a time, so without a repeating check a release published after launch is
      // never seen. `window-show` covers the user coming back to the app.
      setInterval(() => void checkForUpdates("periodic"), UPDATE_CHECK_MS);
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

/**
 * One-click Claude Pro sign-in renewal (F4). Triggered from the dashboard when a
 * dedicated profile's login is dead. Spawns the official CLI's FULL browser flow
 * against that profile's config dir — no refresh-token env, so the CLI opens the
 * system browser for a fresh OAuth authorization (the only thing that clears a
 * rotated/flagged login). Detached and unref'd: the CLI lives until the user
 * completes sign-in, and the next collection cycle picks up the new credentials
 * via ClaudeCliRenewalManager.externalReloginDetected — no restart needed.
 */
/** Active post-renewal credential watcher; replaced on each new request. */
let renewalWatch: NodeJS.Timeout | null = null;

/** Best-effort fingerprint of the on-disk Claude OAuth entry (access + refresh). */
function claudeCredsFingerprint(path: string): string | null {
  try {
    const creds = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const oauth = (creds.claudeAiOauth ?? creds["claude.ai_oauth"] ?? null) as
      | { accessToken?: string; refreshToken?: string }
      | null;
    if (!oauth) return null;
    return createHash("sha256")
      .update(oauth.accessToken || "")
      .update("\0")
      .update(oauth.refreshToken || "")
      .digest("hex")
      .slice(0, 20);
  } catch {
    return null;
  }
}

async function renewClaudeSignin(): Promise<{
  ok: boolean;
  reason?: string;
  configDir?: string;
}> {
  const target = scheduler?.claudeProRenewalTarget() ?? null;
  // Log every click so a silent no-op is diagnosable — the prior bug was a
  // gated target that returned before this line, so clicks vanished.
  usageTracker.event("claude_renew_signin", { target });
  if (!target) return { ok: false, reason: "no-dedicated-profile" };
  const configDir = dirname(target);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A dead/empty login cannot be headless-refreshed — strip every credential
  // env so the CLI falls back to its full browser authorization flow.
  delete env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_SCOPES;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  env.CLAUDE_CONFIG_DIR = configDir;

  try {
    // `claude auth login --claudeai` is INTERACTIVE: it opens a browser and
    // waits for the OAuth callback. It must run in a VISIBLE console window
    // (a detached stdio:"ignore" child has no TTY and silently does nothing).
    // On Windows, `cmd /c start "title" cmd /k <cmd>` pops a new window that
    // inherits this env and stays open so the user sees the URL / any error.
    const child =
      process.platform === "win32"
        ? spawn(
            "cmd.exe",
            ["/c", "start", "DuitSini — Claude sign-in", "cmd.exe", "/k", "claude auth login --claudeai"],
            { env, detached: true, shell: false, stdio: "ignore" },
          )
        : spawn("claude", ["auth", "login", "--claudeai"], {
            env,
            detached: true,
            stdio: "ignore",
          });
    child.on("error", (e) =>
      usageTracker.event("claude_renew_signin_error", { message: e.message }),
    );
    child.unref();

    // Watch for the new credentials so the dashboard updates within seconds of
    // the user completing sign-in, instead of waiting up to a full push cadence
    // for the next tick. Best-effort; the regular cadence is the backstop.
    if (renewalWatch) {
      clearInterval(renewalWatch);
      renewalWatch = null;
    }
    const before = claudeCredsFingerprint(target);
    let polls = 0;
    renewalWatch = setInterval(() => {
      polls += 1;
      const fp = claudeCredsFingerprint(target);
      const detected = before !== null && fp !== null && fp !== before;
      if (detected) {
        if (renewalWatch) clearInterval(renewalWatch);
        renewalWatch = null;
        usageTracker.event("claude_renew_signin_detected", {});
        notifyRenewalResult(true);
        void scheduler?.pullNow();
      } else if (polls >= 40) {
        // ~10 minutes at 15s — the regular cadence takes over from here.
        if (renewalWatch) clearInterval(renewalWatch);
        renewalWatch = null;
        notifyRenewalResult(false);
      }
    }, 15_000);
    renewalWatch.unref();
    return { ok: true, configDir };
  } catch (e) {
    usageTracker.event("claude_renew_signin_error", { message: (e as Error).message });
    return { ok: false, reason: (e as Error).message };
  }
}
ipcMain.handle("duitsini:renew-claude-signin", () => renewClaudeSignin());

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
