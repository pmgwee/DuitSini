import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";

/**
 * Candidate system-browser executables, per OS. Probed ONLY when
 * CHROME_EXECUTABLE_PATH is unset, so local "Send to Telegram" works out of
 * the box without forcing the user to configure an env var.
 *
 * On Vercel/Lambda none of these paths exist, so the launcher naturally falls
 * through to the @sparticuz/chromium-min serverless branch. We deliberately do
 * NOT sniff process.env.VERCEL to pick the branch: VERCEL=1 in BOTH `vercel
 * dev` and deployed runtimes, so it cannot route. "Does a system browser
 * exist on this filesystem?" is the only reliable discriminator.
 *
 * Paths verified against @puppeteer/browsers' resolveSystemExecutablePaths
 * (the same resolver puppeteer-core ships with).
 */
function localBrowserCandidates(): string[] {
  if (platform() === "win32") {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return [
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
      // Edge ships with Windows — the one Chromium guaranteed present even
      // when Chrome isn't installed. 64-bit Edge still installs under
      // ProgramFiles(x86) (Chromium-installer legacy Microsoft never fixed).
      join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  if (platform() === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  // Linux: standard absolute install paths.
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ];
}

/**
 * Launch a real, full system Chrome/Edge. Uses the NEW headless mode
 * (`headless: true`) — NOT "shell", which expects the separate
 * chrome-headless-shell binary that a normal Chrome path is not. No sparticuz
 * args either: chromium.args carries --single-process/--no-sandbox tuned for
 * the Lambda sandbox that destabilize a real system browser.
 */
async function launchLocal(executablePath: string) {
  const args = await puppeteer.defaultArgs();
  return puppeteer.launch({ args, executablePath, headless: true as const });
}

/**
 * Launch the serverless Chromium (@sparticuz/chromium-min). The -min package
 * ships no binary; the Brotli pack is fetched ONCE from CHROMIUM_PACK_URL and
 * cached in /tmp (warm starts reuse it). Host the pack tar yourself — download
 * chromium-vXXX-pack.tar from the Sparticuz GitHub release and put it on S3 /
 * Vercel Blob / a GitHub release asset, then set the URL. This is the path
 * used in production (Vercel/Lambda); locally it errors unless CHROMIUM_PACK_URL
 * is set, which is the correct fallback signal.
 *
 * `@sparticuz/chromium-min` MUST remain in next.config `serverExternalPackages`
 * or its binary-path resolution breaks at runtime on Vercel.
 */
async function launchServerless() {
  chromium.setGraphicsMode = false; // printing needs no WebGL
  const args = await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" as const });
  const executablePath = await chromium.executablePath(process.env.CHROMIUM_PACK_URL);
  return puppeteer.launch({ args, executablePath, headless: "shell" as const });
}

/**
 * Resolve and launch a browser (shared by both render helpers).
 *
 * Launcher resolution (probe-first, no env-sniffing):
 *  1. CHROME_EXECUTABLE_PATH — explicit override, wins.
 *  2. A system browser that exists AND launches (local dev). existsSync-gated
 *     so serverless pays only sub-ms stat calls and zero browser spawns; a
 *     per-candidate try/catch catches arch/permission failures so a present
 *     but unlaunchable binary falls through to the next candidate.
 *  3. @sparticuz/chromium-min serverless branch (Vercel/Lambda prod).
 *  4. Friendly error naming both env vars.
 */
async function launchBrowser(): Promise<Awaited<ReturnType<typeof puppeteer.launch>>> {
  const probeErrors: string[] = [];
  try {
    const envPath = process.env.CHROME_EXECUTABLE_PATH;
    if (envPath) {
      return await launchLocal(envPath);
    }
    for (const candidate of localBrowserCandidates()) {
      if (!existsSync(candidate)) continue;
      try {
        return await launchLocal(candidate);
      } catch (e) {
        probeErrors.push(`${candidate}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return await launchServerless();
  } catch (e) {
    throw new Error(
      `Could not launch Chromium: ${e instanceof Error ? e.message : e}.` +
        (probeErrors.length ? ` Tried local browsers — ${probeErrors.join("; ")}.` : "") +
        " Set CHROME_EXECUTABLE_PATH (local) or CHROMIUM_PACK_URL (serverless).",
    );
  }
}

/**
 * Render a self-contained HTML document to PDF bytes (the stored `report_html`
 * snapshot path — kept for completeness; Send-to-Telegram now uses
 * `renderUrlToPdf` so the PDF matches the live website page).
 */
export async function renderHtmlToPdf(html: string): Promise<Uint8Array> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // The report HTML is self-contained (inline CSS, no external assets), so a
    // single setContent with no network wait renders the full document.
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "16mm", left: "12mm", right: "12mm" },
      timeout: 30_000,
    });
    return new Uint8Array(buffer);
  } finally {
    try {
      await browser.close();
    } catch {
      // Chromium sometimes resists close on serverless; ignore — the process ends.
    }
  }
}

/**
 * Render a LIVE, authenticated page to PDF bytes by navigating to `url` with
 * the caller's session cookies (so RLS-authed SSR renders their own report).
 * The result matches what the in-app Print button produces — the website page
 * is the single source of truth for report styling, sections, and colors.
 *
 * Cookies are scoped to the URL's host and forwarded into the in-process
 * Chromium only; they are never logged. `printBackground: true` is required for
 * the colored cards/bars; Puppeteer's `page.pdf` emulates `@media print`, so the
 * app shell + report chrome hidden by `print:hidden` drop out automatically.
 */
export async function renderUrlToPdf(
  url: string,
  cookies: { name: string; value: string }[] = [],
): Promise<Uint8Array> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    // Desktop-width viewport so the responsive layout (sidebar breakpoints,
    // grid cards) renders as on screen; 2x scale for crisp charts.
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

    if (cookies.length > 0) {
      const domain = new URL(url).hostname;
      await page.setCookie(
        ...cookies.map((c) => ({ name: c.name, value: c.value, domain, path: "/" })),
      );
    }

    await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 });

    // Wait for the Recharts donut to paint (best-effort — a report with no
    // category spend has no svg), then let ResponsiveContainer settle on its
    // explicit h-44/w-44 box before capturing.
    await page.waitForSelector("svg.recharts-surface", { timeout: 15_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    const buffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "10mm", right: "10mm" },
      timeout: 30_000,
    });
    return new Uint8Array(buffer);
  } finally {
    try {
      await browser.close();
    } catch {
      // ignore — the process ends.
    }
  }
}
