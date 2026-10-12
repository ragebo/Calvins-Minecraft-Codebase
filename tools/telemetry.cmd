@echo off
rem Reads the game's content logs and opens the telemetry report. Double-click it, or run it from any folder.
rem Anything after its name goes to the tool: --logs <folder>, --out <folder>, --world <id>, --no-open, --help.
where node >nul 2>nul || (echo Node.js is needed to read the telemetry and was not found. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
node "%~dp0telemetry\cli.mjs" --open %*
if errorlevel 1 pause
