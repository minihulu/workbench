#!/usr/bin/env bash
# 我的工作台 · 主机级备份（独立于容器内自动备份，双保险）
# 打包 ./data（SQLite 主库 + 容器内自动备份）为带时间戳的 tar.gz，并旋转保留最近 N 份。
# 建议加入 cron（每天 04:00）：
#   0 4 * * * /opt/workbench/backup.sh >> /opt/workbench/backups-host/cron.log 2>&1
set -euo pipefail

cd "$(dirname "$0")"
SRC="./data"
DEST="./backups-host"
KEEP=14

mkdir -p "$DEST"

if [ ! -d "$SRC" ]; then
  echo "⚠️  源目录 $SRC 不存在，跳过（服务可能还没起来过）。" >&2
  exit 0
fi

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$DEST/wb-data-$TS.tar.gz"

tar -czf "$OUT" -C . data
echo "📦 已备份： $OUT ($(du -h "$OUT" | cut -f1))"

# 旋转：保留最近 KEEP 份，超出删除最旧的
ls -1t "$DEST"/wb-data-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
echo "🧹 保留最近 $KEEP 份。"
