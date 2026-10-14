@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE_EXE=node"
where node >nul 2>nul || set "NODE_EXE=D:\node.exe"

"%NODE_EXE%" "%~dp0checkin.js" %*
exit /b %ERRORLEVEL%
