@echo off
chcp 65001
setlocal

rem Locate python: prefer the managed runtime, fall back to PATH.
rem Wildcard avoids hardcoding a non-ASCII user folder name.
set "PY="
for %%P in ("C:\Users\*\.workbuddy\binaries\python\envs\default\Scripts\python.exe") do set "PY=%%~fP"
if not exist "%PY%" (
  for %%P in ("C:\Users\*\.workbuddy\binaries\python\versions\3.13.12\python.exe") do set "PY=%%~fP"
)
if not exist "%PY%" set "PY=python"

"%PY%" "%~dp0_push_to_github.py"

echo.
echo Press any key to close...
pause >nul
endlocal
