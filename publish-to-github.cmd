@echo off
rem Double-click to publish Crime Radar MY to GitHub Pages (runs publish-to-github.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-to-github.ps1"
