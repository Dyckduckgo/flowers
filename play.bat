@echo off
rem double-click this, or type "play" in cmd from this folder. any options pass through, e.g.  play --loop
cd /d "%~dp0"
python art.py %*
