@echo off
chcp 65001 >nul
title HALCYON
cd /d "%~dp0"
if not defined LOG_LEVEL set LOG_LEVEL=info
echo Starting HALCYON on https://localhost:8443 (LOG_LEVEL=%LOG_LEVEL%)
echo.
node server.js
echo.
echo Server stopped. Press any key to exit.
pause >nul
