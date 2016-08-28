@echo off
rem usage: relaunch_app.bat <seconds to wait> <executable to launch> <arguments>
rem i.e. $>relaunch_app.bat 5 "C:\Program Files\Jujusoft\JujuEdit\JujuEdit.exe" "C:\Windows\system.ini"

echo Restarting in %1 seconds...
title Waiting

rem Windows 7
@timeout /t %1 /nobreak >nul 2>&1

rem Windows XP
if errorlevel 1 ping 192.0.2.2 -n 1 -w %1000 > nul

rem # launch the executable via start command
pushd %~dp0
hstart.exe /RUNAS ^""%~2" "%~3" "%~4" "%~5" "%~6" "%~7" "%~8""
popd
