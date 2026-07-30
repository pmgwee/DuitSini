#!/usr/bin/env node
/**
 * Build-time guard: preload scripts must not touch main-process-only Electron APIs.
 *
 * WHY THIS EXISTS (the v1.1.1–v1.1.4 outage)
 * ------------------------------------------
 * A preload runs in the RENDERER process. `require("electron").app` is
 * `undefined` there, so `app.getVersion()` throws — and a throw in a preload
 * aborts the ENTIRE script, silently skipping every statement below it.
 *
 * `79512d4` added exactly that one line to preload.ts. It killed:
 *   - window.duitsiniDesktopVersion  (footer version badge)
 *   - window.duitsiniUpdater         (header update badge)
 *   - ipcRenderer.on("duitsini:mint") (the ENTIRE usage bridge — Claude + GLM)
 *
 * It shipped in four consecutive releases because nothing catches it: Electron
 * does not print preload errors to stdout, the window still loads normally, and
 * TypeScript is no help — `import { app } from "electron"` type-checks perfectly,
 * since the type definitions do not model which process a module is legal in.
 *
 * This script is that missing check. It runs as part of `pnpm build`, so it
 * gates `dev`, `dist` and every packaged release.
 *
 * Run standalone:  node scripts/check-preload.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Any file with "preload" anywhere in its name, at any depth under src/.
 * Deliberately loose: a guard that only matched `preload*.ts` at the top level
 * would silently skip a future `bridge-preload.ts` or `windows/preload.ts` —
 * i.e. it would go quiet exactly when someone adds a new preload, which is when
 * it matters most.
 */
function findPreloads(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findPreloads(full, out);
    else if (/preload/i.test(entry.name) && /\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Modules `require("electron")` actually defines in a preload, verified by
 * enumeration against Electron 43.2.0 (not copied from docs):
 *
 *   clipboard, contextBridge, crashReporter, ipcRenderer, nativeImage,
 *   sharedTexture, shell, webFrame, webUtils
 *
 * Deliberately an ALLOW-list, not a deny-list: a main-only module that Electron
 * adds in a future version is then rejected by default instead of slipping
 * through a stale blocklist.
 */
const RENDERER_SAFE = new Set([
  "clipboard",
  "contextBridge",
  "crashReporter",
  "ipcRenderer",
  "nativeImage",
  "sharedTexture",
  "shell",
  "webFrame",
  "webUtils",
]);

/** Everything else is main-only; named here purely for a better error message. */
const KNOWN_MAIN_ONLY = new Set([
  "app", "BrowserWindow", "dialog", "session", "Tray", "Menu", "ipcMain",
  "screen", "globalShortcut", "protocol", "powerMonitor", "autoUpdater",
  "net", "safeStorage", "webContents", "MenuItem", "Notification",
  "desktopCapturer", "inAppPurchase", "powerSaveBlocker", "systemPreferences",
  "nativeTheme", "utilityProcess", "BaseWindow", "WebContentsView",
]);

const problems = [];

/** `import { a, b as c } from "electron"` / `import electron from "electron"`. */
const IMPORT_RE = /import\s+([^;]+?)\s+from\s+["']electron["']/g;
/** `require("electron")` destructuring, for any .mjs/.js preload variants. */
const REQUIRE_RE = /(?:const|let|var)\s*(\{[^}]*\})\s*=\s*require\(\s*["']electron["']\s*\)/g;

function checkNames(file, clause, raw) {
  const braced = clause.match(/\{([^}]*)\}/);
  if (!braced) {
    // A default/namespace import (`import electron from "electron"`) hands the
    // whole module object over, so this guard cannot see which members get used.
    problems.push(
      `${file}: namespace/default import of "electron" (${raw.trim()}).\n` +
        `    Use a named import so this check can verify each member is renderer-safe.`,
    );
    return;
  }
  for (const part of braced[1].split(",")) {
    // Strip `type` modifiers and `as` aliases: `type Foo`, `app as electronApp`.
    const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
    if (!name) continue;
    // `import type { ... }` is erased at compile time and cannot throw.
    if (/^import\s+type/.test(raw)) return;
    if (RENDERER_SAFE.has(name)) continue;
    const known = KNOWN_MAIN_ONLY.has(name);
    problems.push(
      `${file}: imports "${name}" from "electron".\n` +
        `    ${known ? "That is a MAIN-process module" : "That is not on the renderer-safe list"} — ` +
        `it is undefined in a preload, so touching it throws and aborts the WHOLE preload\n` +
        `    (killing the usage-mint listener and every window.* bridge below it).\n` +
        `    Renderer-safe: ${[...RENDERER_SAFE].join(", ")}.\n` +
        `    Need a value only the main process has? Pass it via ` +
        `webPreferences.additionalArguments, or fetch it over IPC.`,
    );
  }
}

const preloads = findPreloads(SRC);
if (preloads.length === 0) {
  console.error("check-preload: no preload files found under src/ — has the layout changed?");
  process.exit(1);
}

for (const full of preloads) {
  const file = relative(SRC, full).replace(/\\/g, "/");
  const source = readFileSync(full, "utf8");
  for (const m of source.matchAll(IMPORT_RE)) checkNames(file, m[1], m[0]);
  for (const m of source.matchAll(REQUIRE_RE)) checkNames(file, m[1], m[0]);
}

if (problems.length > 0) {
  console.error("\n  PRELOAD SAFETY CHECK FAILED\n");
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error(
    "  This exact mistake silently broke AI usage tracking across v1.1.1-v1.1.4.\n" +
      "  See the header comment in desktop/src/preload.ts.\n",
  );
  process.exit(1);
}

const names = preloads.map((p) => relative(SRC, p).replace(/\\/g, "/"));
console.log(`check-preload: ok (${names.join(", ")})`);
