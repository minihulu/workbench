@echo off
cd /d "%~dp0"

REM ---- Find Python ----
set "PY="

REM 1) Try PATH
for %%P in (python python3 py) do (
  where %%P >nul 2>nul && set "PY=%%P" && goto :found
)

REM 2) Common install dirs
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do (
  if exist "%%D\python.exe" set "PY=%%D\python.exe" && goto :found
)

REM 3) WorkBuddy managed Python
if exist "%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe" (
  set "PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
  goto :found
)

echo [ERROR] Python not found.
pause
exit /b

:found
echo Starting Workbench Server...
echo (Close window to stop; open http://localhost:8000 if no browser)
echo.
set OPEN_BROWSER=1
%PY% server.py
if errorlevel 1 (
  echo.
  echo [server.py error - see above]
  pause
)
