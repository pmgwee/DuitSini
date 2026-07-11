import { type NextRequest } from "next/server";
import { zipSync, strToU8 } from "fflate";
import { buildMemberBridge } from "@/lib/bridge/member-bridge-template";
import { mintBridgeToken } from "@/lib/bridge/mint-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WIN_BAT = `@echo off
title Claude Usage Sharer
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node is not installed yet. It is free and takes 2 minutes.
  echo   1^) A website will open. Click the big green "LTS" download button.
  echo   2^) Open the downloaded file and click Next until Finish.
  echo   3^) Then double-click START-HERE again.
  echo.
  start "" "https://nodejs.org/en/download"
  echo   Press any key to close this window.
  pause >nul
  exit /b
)
node "claude-usage-sharer.mjs"
echo.
echo   The sharer stopped. You can close this window.
pause >nul
`;

const README = `CLAUDE USAGE SHARER  -  simple setup (about 2 minutes)

WHAT THIS DOES
  It reads YOUR Claude usage from your own computer and shows it,
  live, on the class dashboard. It only sends the percentages (like
  "53%") - never your password, your login, or anything else.

  It can show MORE THAN ONE source at once - for example your Claude
  Pro/Max subscription AND a GLM Coding plan - side by side. (Optional;
  see "TWO SOURCES" below if you want that.)

BEFORE YOU START
  You just need Claude Code installed and signed in with your Claude
  account - the same one you already use. That's it.

--- WINDOWS (this ZIP) ---
  1. If this is still a .zip, unzip it first:
     right-click the zip  ->  "Extract All..."  ->  Extract.
  2. Double-click:   START-HERE (Windows).bat
  3. A black window opens (that's normal).
     - If it says Node is missing, follow the 3 steps it shows
       (install Node once), then double-click START-HERE again.
  4. Leave that window OPEN. Go to the dashboard - your usage is now live!

  To stop sharing: just close the black window.

--- MAC ---
  Don't use this ZIP on a Mac. On the dashboard, switch the setup card to
  "macOS" and copy the one-line command it gives you. Then:
  1. Open the Terminal app (press Cmd+Space, type "Terminal", Enter).
  2. Paste the command, press Enter.
  3. Leave that window OPEN. Your usage is now live on the dashboard!

  (macOS blocks double-clickable script files downloaded from the web, so
  the copy-paste command is the simple, safe way - nothing to unblock.)

  To stop sharing: just close the window.

--- TWO SOURCES (optional): Claude Pro + GLM side by side ---
  Claude's usage is account-level, so you do NOT need Claude Desktop - any
  Claude Code login with your Pro/Max account shows the same numbers. To
  keep a Pro login separate from a GLM-routed CLI, sign in once into a
  dedicated folder:

    On Windows (PowerShell):
      $env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\\.claude-pro"
      claude          # then choose "Claude.ai subscription" and sign in

    On Mac / Linux:
      CLAUDE_CONFIG_DIR=~/.claude-pro claude   # sign in with your Pro account

  That creates ~/.claude-pro/.credentials.json with a Pro token. The sharer
  finds it automatically (along with ~/.claude-sub, CLAUDE_SUB_CONFIG_DIR,
  and your normal ~/.claude). Your GLM usage is read from your cc-switch
  setup, untouched. Both then appear live on the dashboard.

IS THIS SAFE?
  Yes. It only reads your Claude usage numbers and sends the percentages
  to the class dashboard. It never sends your password or login, and it
  can't change anything on your computer. Close the window to stop anytime.
`;

/**
 * GET — hand the signed-in member a personalized Windows ZIP: a self-contained
 * bridge script (their per-user token baked in), a double-click launcher, and a
 * plain README. Each download mints a fresh token; multiple tokens per user are
 * allowed, so re-downloading does NOT stop a sharer that's already running. Mac
 * users get a copy-paste command instead (/api/bridge/mac-command) because macOS
 * blocks quarantined double-click launchers.
 */
export async function GET(req: NextRequest) {
  const minted = await mintBridgeToken();
  if (!minted.ok) {
    return new Response(minted.message, { status: minted.status });
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
  const bridge = buildMemberBridge({
    ingestUrl: `${base}/api/claude-usage/ingest`,
    pullUrl: `${base}/api/claude-usage/pull`,
    token: minted.token,
    accountEmail: minted.email ?? "",
  });

  const zip = zipSync(
    {
      "claude-usage-sharer.mjs": strToU8(bridge),
      "START-HERE (Windows).bat": strToU8(WIN_BAT),
      "README.txt": strToU8(README),
    },
    { level: 6 },
  );

  // Copy into a clean ArrayBuffer-backed view for the Response body.
  const body = new Uint8Array(zip);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="claude-usage-sharer.zip"',
      "Cache-Control": "no-store",
    },
  });
}
