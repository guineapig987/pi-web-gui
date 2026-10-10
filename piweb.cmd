@echo off
rem pi-web helper. Usage: piweb ^<command^>. Run "piweb setup" once to use it from any folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pi-web-service.ps1" %*
