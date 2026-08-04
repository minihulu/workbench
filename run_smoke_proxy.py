# -*- coding: utf-8 -*-
"""Supabase smoke test launcher - local HTTP proxy mode.
Called by run_smoke_test_proxy.cmd. Forwards to supabase/smoke_test.py
with HTTPS_PROXY pointed at FlClash's local HTTP proxy (default 7890).
Edit PROXY below if your FlClash uses a different port.
"""
import os
import sys
import subprocess
import traceback

os.system("chcp 65001 >nul")

os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"

# FlClash HTTP proxy. 7890 is the Clash-family default; change here
# (or set env HTTPS_PROXY before launching) if yours differs.
PROXY = os.environ.get("WB_PROXY") or "http://127.0.0.1:7890"
for _k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
    os.environ[_k] = PROXY

ROOT = os.path.dirname(os.path.abspath(__file__))
_PYHOME = os.environ.get("USERPROFILE") or os.path.expanduser("~")
PYEXE = os.path.join(_PYHOME, ".workbuddy", "binaries", "python", "envs", "default", "Scripts", "python.exe")
SCRIPT = os.path.join(ROOT, "supabase", "smoke_test.py")

print("=" * 60)
print(" WorkBuddy Supabase smoke test (via local proxy)")
print(" Proxy:", PROXY)
print(" If your FlClash port differs, edit PROXY in this file")
print(" or set env WB_PROXY=http://127.0.0.1:<port> before running.")
print("=" * 60)
print()

_rc = 1
try:
    _rc = subprocess.call([PYEXE, SCRIPT], cwd=ROOT)
except Exception:
    print("\nLauncher error:")
    traceback.print_exc()
finally:
    print()
    print("Exit code:", _rc)
    try:
        input("\nPress Enter to exit...")
    except Exception:
        pass