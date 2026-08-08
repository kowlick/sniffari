@echo off
rem ---------------------------------------------------------------------------
rem  Restart the Sniffari server.
rem
rem  Double-click it, or run restart.bat from anywhere - it cd's to the repo
rem  first. Optional argument: a port, if you are not on the default 9663.
rem
rem      restart.bat            restart on 9663
rem      restart.bat 8080       restart on 8080
rem
rem  It frees the port before starting, because the usual reason you want a
rem  restart is that an old `node src/server/index.ts` is still holding it and
rem  the new one would die with EADDRINUSE. Only node is killed; anything else
rem  holding the port is reported and left alone.
rem
rem  Deliberately plain cmd, no PowerShell. The first version shelled out to a
rem  `^`-continued PowerShell one-liner, and the escaped pipe inside its quoted
rem  argument did not survive cmd's parser - the port check silently matched
rem  nothing, reported "port is free", and then handed you an EADDRINUSE crash.
rem  netstat and taskkill need no escaping games.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "PORT=9663"
if not "%~1"=="" set "PORT=%~1"

echo.
echo   Freeing port %PORT% ...

set "FOUND="
set "BLOCKED="
for /f "tokens=5" %%p in ('netstat -ano -p TCP ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  call :stopone %%p
)
if not defined FOUND echo     nothing was listening

if defined BLOCKED goto blocked

rem Windows releases the socket a moment after the process dies, so poll for it
rem rather than sleeping a guessed amount and losing the race.
set /a TRIES=0
:waitfree
netstat -ano -p TCP | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 goto freed
set /a TRIES+=1
if %TRIES% geq 20 goto stuck
rem ping is the sleep that does not touch stdin; `timeout` fails when redirected.
ping -n 2 127.0.0.1 >nul 2>&1
goto waitfree

:stuck
echo   ERROR: port %PORT% was still in use after 20 tries.
goto abort

:blocked
echo   ERROR: port %PORT% is held by something that is not node.
goto abort

:abort
echo.
echo   Not starting. See the message above.
echo.
pause
exit /b 1

:freed
echo     port is free
echo   Starting Sniffari on port %PORT% ...
echo.
call npm start

rem If the server exits (a crash, or Ctrl-C), hold the window open so the error
rem is readable instead of the console vanishing on a double-click.
echo.
echo   Server stopped.
pause
exit /b 0

rem --- kill one listener, if and only if it is node ---------------------------
:stopone
for /f "tokens=1" %%n in ('tasklist /nh /fi "PID eq %~1" 2^>nul') do (
  if /i "%%n"=="node.exe" (
    echo     stopping node.exe ^(PID %~1^)
    taskkill /f /t /pid %~1 >nul 2>&1
  ) else if /i not "%%n"=="INFO:" (
    echo     WARNING: PID %~1 on this port is %%n, not node - leaving it alone
    set "BLOCKED=1"
  )
)
exit /b 0
