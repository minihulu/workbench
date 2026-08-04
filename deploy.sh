#!/usr/bin/env bash
# 我的工作台 · 一键上云部署脚本（在服务器上运行）
# 前置：项目目录已拷到本机（建议 /opt/workbench），且装好 Docker + compose v2。
# 用法：
#   cd /opt/workbench
#   ./deploy.sh
set -euo pipefail

cd "$(dirname "$0")"

# 1) 确保 .env 存在
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "✏️  已生成 .env，请先编辑关键项后再运行："
    echo "      nano .env"
    echo "   至少改： DOMAIN、EMAIL、ADMIN_TOKEN、INVITE_CODES"
    exit 1
  else
    echo "❌ 缺少 .env.example，无法继续。" >&2
    exit 1
  fi
fi

# 2) 载入并做最简校验
# shellcheck disable=SC1091
source .env

if [ -z "${DOMAIN:-}" ] || [ "${DOMAIN:-}" = "workbench.example.com" ]; then
  echo "⚠️  请先把 .env 里的 DOMAIN 改成你的真实域名。" >&2
  exit 1
fi
if [ -z "${ADMIN_TOKEN:-}" ] || [ "${ADMIN_TOKEN:-}" = "please-change-me-to-a-long-random-string" ]; then
  echo "⚠️  请先把 .env 里的 ADMIN_TOKEN 改成随机长串。" >&2
  exit 1
fi

# 3) 拉起服务（含 Caddy 自动申请证书）
echo "==> 启动「我的工作台」+ Caddy(自动 HTTPS) ..."
docker compose -f docker-compose.prod.yml up -d --build

echo
echo "✅ 部署完成！"
echo "   访问地址： https://${DOMAIN}/"
echo "   查看日志： docker compose -f docker-compose.prod.yml logs -f"
echo "   停止服务： docker compose -f docker-compose.prod.yml down"
echo "   手动备份： ./backup.sh"
echo
echo "📱 手机端：安卓用 Android Studio 打开 ./android 出包（改 MainActivity 的 BACKEND_URL 为上面域名）；"
echo "    或手机 Chrome 打开该域名 → 添加到主屏幕，即获得近似 App 的体验。"
echo
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  echo "🗄️  存储后端：Supabase（${SUPABASE_URL}）｜ 若初始化失败将自动回退本地 SQLite。"
else
  echo "🗄️  存储后端：本地 SQLite（未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）。"
fi
