# -*- coding: utf-8 -*-
"""Supabase smoke test launcher - TUN / direct mode.
Called by run_smoke_test.cmd. Forwards to supabase/smoke_test.py with
proxy env vars cleared so traffic goes through FlClash virtual NIC (TUN).
"""
import os
import sys
import subprocess
import traceback

# Make sure console can display Chinese (belt-and-suspenders; the .cmd
# already did chcp 65001, this re-applies inside a child cmd that exits
# cleanly so it cannot leak a NUL handle into our stdout).
os.system("chcp 65001 >nul")

# Python output must be UTF-8 bytes; console (now 65001) will render them.
os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"

# Direct connection (no proxy = no FlClash/VPN needed). This is exactly the
# path server.py uses in normal daily use on the user's own machine.
for _k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy",
           "ALL_PROXY", "all_proxy"):
    os.environ.pop(_k, None)

ROOT = os.path.dirname(os.path.abspath(__file__))
_PYHOME = os.environ.get("USERPROFILE") or os.path.expanduser("~")
PYEXE = os.path.join(_PYHOME, ".workbuddy", "binaries", "python", "envs", "default", "Scripts", "python.exe")
SCRIPT = os.path.join(ROOT, "supabase", "smoke_test.py")

print("=" * 60)
print(" WorkBuddy Supabase smoke test (direct / no VPN)")
print(" Connects straight to Supabase like your browser did.")
print(" Normal use needs NO FlClash/VPN: just keep FlClash OFF,")
print(" or not in fake-IP-without-TUN mode. If it errors with")
print(" SSL/connect, enable FlClash TUN or use run_smoke_test_proxy.cmd.")
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