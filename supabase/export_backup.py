# -*- coding: utf-8 -*-
"""Supabase → 本地 JSON 周期导出（替代原 wb.db 文件复制式备份，见 DESIGN.md §6）。

用法：
  python supabase/export_backup.py                 # 导出到 DATA_DIR/backups/
  python supabase/export_backup.py --out /path     # 指定目录
  python supabase/export_backup.py --keep 14       # 保留份数

输出：backups/wb-YYYYmmdd-HHMMSS.json.gz
结构：
{
  "schema_version": 1,
  "exported_at": 1730000000,
  "source": "supabase://<project-ref>",
  "profiles": [{"uid","username","auth_email","legacy_uid","created_at"}],  # 不含 token_epoch
  "sync":     [{"uid","payload","payload_version","updated_at"}]
}
"""
import os
import sys
import gzip
import json
import time
import argparse

# 让本脚本既能独立运行，也能被 server.py import
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import supabase_store  # noqa: E402


def run(data_dir=None, keep=7):
    data_dir = data_dir or supabase_store._env("DATA_DIR") or os.getcwd()
    keep = int(keep)
    supabase_store.init()

    backup_dir = os.path.join(data_dir, "backups")
    os.makedirs(backup_dir, exist_ok=True)

    svc = supabase_store._svc()
    # profiles（排除 token_epoch 等安全字段）
    profiles = svc.table("profiles").select(
        "uid,username,auth_email,legacy_uid,created_at").execute().data or []
    # sync 全量（单用户几十 KB，无需分页；>1000 行时按 range 扩展）
    sync = svc.table("sync").select(
        "uid,payload,payload_version,updated_at").execute().data or []

    payload = {
        "schema_version": 1,
        "exported_at": int(time.time()),
        "source": "supabase://%s" % (supabase_store._env("SUPABASE_URL").split("//")[-1].split(".")[0] or "unknown"),
        "profiles": profiles,
        "sync": sync,
    }
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")

    ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    dst = os.path.join(backup_dir, "wb-%s.json.gz" % ts)
    with open(dst, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", mtime=int(time.time())) as gz:
            gz.write(blob)
    try:
        os.chmod(dst, 0o600)
    except Exception:
        pass

    # 清理旧备份，保留最近 keep 份
    files = sorted(
        (f for f in os.listdir(backup_dir) if f.startswith("wb-") and f.endswith(".json.gz")),
        reverse=True,
    )
    for old in files[keep:]:
        try:
            os.remove(os.path.join(backup_dir, old))
        except Exception:
            pass

    return {"ok": True, "file": dst, "profiles": len(profiles), "sync": len(sync)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="输出目录（默认 DATA_DIR/backups）")
    ap.add_argument("--keep", default=7, help="保留份数（默认 7）")
    args = ap.parse_args()
    data_dir = args.out or (os.path.join(supabase_store._env("DATA_DIR"), "backups")
                            if supabase_store._env("DATA_DIR") else None)
    try:
        res = run(data_dir=data_dir, keep=args.keep)
        print("✅ 备份完成:", res)
    except Exception as e:
        print("❌ 备份失败:", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
