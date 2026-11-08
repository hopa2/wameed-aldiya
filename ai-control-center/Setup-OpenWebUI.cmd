@echo off
REM Double-click this file. It asks for Administrator rights (needed for the
REM Tailscale-only firewall rule) and then runs Setup-OpenWebUI.ps1.
REM Extra options can be added after the name, for example:
REM   Setup-OpenWebUI.cmd -PullModels -OptimizeOllama
REM The window stays open at the end so you can read the result.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -NoExit -ExecutionPolicy Bypass -File \"%~dp0Setup-OpenWebUI.ps1\" %*'"
