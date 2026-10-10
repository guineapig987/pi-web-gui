@echo off
rem pi web launcher for Windows: double-click or run start.cmd from a terminal.
cd /d "%~dp0"
node server.mjs --open %*
if errorlevel 1 pause
