@echo off
REM Double-click to start the Ropo Tally Bridge (keep this window open while staff are working).
cd /d "%~dp0"
:loop
node bridge.js
echo Bridge stopped. Restarting in 10 seconds...
timeout /t 10 >nul
goto loop
