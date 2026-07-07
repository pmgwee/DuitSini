import { type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { hashBridgeToken } from "@/lib/claude-usage/bridge-auth";
import { buildMemberBridge } from "@/lib/bridge/member-bridge-template";

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

const MAC_CMD = `#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node is not installed yet. It is free and takes 2 minutes."
  echo "  A website will open - download the green 'LTS' version, install it,"
  echo "  then double-click this file again."
  open "https://nodejs.org/en/download" 2>/dev/null || true
  read -n 1 -s -r -p "  Press any key to close."
  exit 0
fi
node "claude-usage-sharer.mjs"
echo ""
echo "  The sharer stopped. You can close this window."
read -n 1 -s -r -p "  Press any key to close."
`;

const README = `CLAUDE USAGE SHARER  -  simple setup (about 2 minutes)

WHAT THIS DOES
  It reads YOUR Claude Code usage from your own computer and shows it,
  live, on the class dashboard. It only sends the percentages (like
  "53%") - never your password, your login, or anything else.

BEFORE YOU START
  You just need Claude Code installed and signed in with your Claude
  account - the same one you already use. That's it.

--- WINDOWS ---
  1. If this is still a .zip, unzip it first:
     right-click the zip  ->  "Extract All..."  ->  Extract.
  2. Double-click:   START-HERE (Windows).bat
  3. A black window opens (that's normal).
     - If it says Node is missing, follow the 3 steps it shows
       (install Node once), then double-click START-HERE again.
  4. Leave that window OPEN. Go to the dashboard - your usage is now live!

  To stop sharing: just close the black window.

--- MAC ---
  1. Unzip this folder (double-click the zip).
  2. Right-click  "start (Mac).command"  ->  Open  ->  Open.
     (Right-click Open is only needed the first time.)
     - If it says "permission denied": open the Terminal app, type
       "chmod +x " (with a space), drag the start (Mac).command file
       onto the Terminal window, press Enter, then double-click it again.
  3. Leave the window OPEN. Your usage is now live on the dashboard!

  To stop sharing: just close the window.

IS THIS SAFE?
  Yes. It only reads your Claude usage numbers and sends the percentages
  to the class dashboard. It never sends your password or login, and it
  can't change anything on your computer. Close the window to stop anytime.
`;

/**
 * GET — hand the signed-in member a personalized ZIP: a self-contained bridge
 * script (their per-user token baked in), double-click launchers, and a plain
 * README. Each download mints a fresh token (older downloads stop working).
 */
export async function GET(req: NextRequest) {
  if (!isAdminConfigured()) {
    return new Response("Sharing isn't configured on the server yet.", { status: 503 });
  }
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return new Response("Please sign in first.", { status: 401 });
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
  const token = `cub_${randomBytes(24).toString("hex")}`;

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("bridge_tokens").upsert({
    user_id: user.id,
    token_hash: hashBridgeToken(token),
    created_at: new Date().toISOString(),
    last_used_at: null,
  });
  if (error) {
    return new Response("Could not prepare your sharer. Try again.", { status: 500 });
  }

  const bridge = buildMemberBridge({
    ingestUrl: `${base}/api/claude-usage/ingest`,
    pullUrl: `${base}/api/claude-usage/pull`,
    token,
  });

  const zip = zipSync(
    {
      "claude-usage-sharer.mjs": strToU8(bridge),
      "START-HERE (Windows).bat": strToU8(WIN_BAT),
      "start (Mac).command": strToU8(MAC_CMD),
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
