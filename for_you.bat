@echo off
rem double-click to open the card. press enter when they're ready.
cd /d "%~dp0"
mode con: cols=130 lines=38
python for_you.py %*
