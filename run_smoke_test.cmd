@echo off
setlocal
set "PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" (
  echo [ERROR] python not found: %PY%
  echo         Check .workbuddy\binaries\python\envs\default exists under your user profile.
  goto :end
)
echo Using Python: %PY%
"%PY%" "%~dp0run_smoke_tun.py"
:end
pause