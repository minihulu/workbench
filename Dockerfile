# syntax=docker/dockerfile:1
# 「我的工作台」后端镜像
# 默认零依赖（仅 Python 标准库，本地 SQLite）。启用 Supabase 存储后端时需装依赖（requirements.txt）。
FROM python:3.13-slim

WORKDIR /app

# 复制后端、前端静态文件与 Supabase 存储层
# （.dockerignore 已排除密钥 wb.env、数据 *.db/backups/data、构建产物、文档）
COPY server.py workbench.html index.html supabase_store.py requirements.txt /app/
COPY supabase/ /app/supabase/
COPY 128x128.png 128x128@2x.png 32x32.png icon.ico icon.png /app/

# Supabase 模式依赖（本地 SQLite 模式下未用到，但一并装上无害）
RUN pip install --no-cache-dir -r requirements.txt

# 运行时数据挂在 /data（由 docker-compose 映射到 ./data，容器重建不丢）
ENV DATA_DIR=/data \
    PORT=8000

EXPOSE 8000

# 健康检查：server.py 自带 GET /api/health -> {"ok":true}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"

CMD ["python", "server.py"]
