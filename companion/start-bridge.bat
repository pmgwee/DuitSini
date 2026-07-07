@echo off
title Claude Usage Bridge
cd /d "%~dp0"
echo Claude Usage Bridge is running. Close this window to stop it.
echo.
"C:\Program Files\nodejs\node.exe" --env-file=.env claude-usage-bridge.mjs
echo.
echo Bridge stopped. Press any key to close.
pause >nul
