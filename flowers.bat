@echo off
rem double-click this, or type "flowers" in cmd from this folder. options pass through, e.g.  flowers --speed 0.6
cd /d "%~dp0"
python flowers.py %*
