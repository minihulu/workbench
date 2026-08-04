# 工作台 · 部署文档（网盘模式：账号 + 多端云端同步）

本目录含一个**单文件前端**（`workbench.html` / `index.html`）和一个**零依赖后端**（`server.py`，仅用 Python 标准库）。
已实现：账号注册/登录、**邀请码注册**、多端云端同步、**实时多端同步（SSE）**、**离线冲突合并（记录级合并 + 删除墓碑）**、**GitHub 搜索代理**、**基础限流**、**自动备份**、**管理后台**。

---

## 一、本地直接运行（无 Docker）

```bash
cd /workspace
python3 server.py
# 打开 http://localhost:8000/
```

- 端口：`PORT=9000 python3 server.py`
- 数据目录（SQLite 与备份）：`DATA_DIR=/var/lib/wb python3 server.py`，默认与 server.py 同目录
- **GitHub 代理（重点）**：浏览器直连 `api.github.com` 在国内通常被墙，所以搜索走后端代理。
  - 后端会自动读取出网代理，优先级：`GH_PROXY` 环境变量 > `HTTPS_PROXY`/`HTTP_PROXY` 环境变量 > **Windows 系统代理（注册表，Clash 等）**。
  - 如果你双击 `.exe` 或 `start.bat` 仍搜不到 GitHub，多半是运行 server 的机器没配置出网代理。最稳的做法：显式指定
    `GH_PROXY=http://127.0.0.1:7890 python3 server.py`（把 7890 换成你 Clash/v2ray 的端口）。
  - 也可以给后端一个 GitHub Token 提升限额：`GH_TOKEN=ghp_xxx python3 server.py`（前端「GitHub Token」填的是浏览器侧个人 token，二者独立）。
  - 健康检查：`GET /api/health` 会回显当前生效的代理；`GET /api/config` 回显 `github_proxy` 是否为真。

---

## 二、Docker 部署（给别人用 · 推荐）

别人一条命令就能起：

```bash
# 在含 docker-compose.yml 的目录
docker compose up -d            # 构建并后台启动
docker compose logs -f          # 看日志
docker compose down             # 停止
```

- 访问 `http://<服务器IP>:8000/`
- 数据在卷 `./data`（容器内 `/data`，含 `wb.db` 与 `backups/`），容器重建不丢数据
- 健康检查：`GET /api/health` 返回 `{"ok":true}`

### 常用环境变量（改 `docker-compose.yml` 的 `environment`）

| 变量 | 说明 |
|------|------|
| `REGISTER_OPEN` | `1` 公开注册；`0` 关闭（给别人用时建议先关，改用邀请码） |
| `REGISTER_REQUIRE_INVITE` | `1` 注册必须邀请码 |
| `INVITE_CODES` | 逗号分隔的初始邀请码，例如 `wb-aaa,wb-bbb` |
| `GH_TOKEN` | GitHub Personal Access Token（提升搜索限额到 5000/h） |
| `GH_PROXY` | 出网代理，例如 `http://127.0.0.1:7890`（解决服务器直连 GitHub 被墙） |
| `ADMIN_TOKEN` | 管理后台口令（设了才开启 `/api/admin/*`） |
| `BACKUP_INTERVAL` | 自动备份间隔秒（默认 `21600`=6h），`0` 关闭 |
| `DATA_DIR` | 数据目录，容器内固定 `/data`（已挂卷） |

> 注：邀请码一旦被使用会写入库并标记已用，无法重复注册；在管理后台可看到已用/未用情况。

### ⭐ 一键上云版（含 Caddy，自动 HTTPS，推荐给别人用）

上面的 `docker-compose.yml` 是把 8000 端口直接暴露出来。给别人用、上公网时，最佳做法是**再加一层 Caddy 反代自动申请/续期证书**，一条命令就把「后端 + HTTPS」全拉起来，手机/网页/桌面端填同一个 `https://域名` 即多端互通。

项目里已备好整套文件：

| 文件 | 作用 |
|------|------|
| `docker-compose.prod.yml` | 编排后端容器 + Caddy 容器（同网络，8000 不对外裸奔） |
| `Caddyfile` | 反代配置，自动申请 Let's Encrypt 证书；已处理 SSE 长连接（`flush_interval -1`） |
| `.env.example` | 配置模板（域名/邮箱/邀请码/管理令牌等） |
| `deploy.sh` | 一键部署脚本：校验 `.env` → `docker compose up -d --build` |
| `backup.sh` | 主机级备份 `./data` 为带时间戳 tar.gz，旋转保留 14 份 |
| `workbench.service` | systemd 单元，开机自启（可选） |

**在云服务器上的操作流程（一条命令上线）：**

```bash
# 1) 把整个项目目录拷到服务器，建议放 /opt/workbench
# 2) 进目录，准备配置
cd /opt/workbench
cp .env.example .env
nano .env            # 必改：DOMAIN、EMAIL、ADMIN_TOKEN、INVITE_CODES

# 3) 一键部署（脚本会校验关键项后拉起服务）
chmod +x deploy.sh backup.sh
./deploy.sh

# 4) 浏览器打开 https://你的域名/  即可使用
```

**前置条件（需你这边准备）：**
- 一台公网服务器（阿里云/腾讯云/自建均可），已装 Docker + docker compose v2；
- 一个域名，A 记录已解析到这台服务器公网 IP；
- 服务器防火墙/安全组放行 **80 与 443**（ACME 验证 + HTTPS 必须）。

**可选：开机自启（systemd）**

```bash
cp workbench.service /etc/systemd/system/workbench.service
systemctl daemon-reload
systemctl enable --now workbench
# 之后 reboot 会自动拉起；日志看：journalctl -u workbench -f
```

**日常运维**
- 看日志：`docker compose -f docker-compose.prod.yml logs -f`
- 升级：把新代码拷进来后 `./deploy.sh`（会重新 build）
- 备份：`crontab -e` 加 `0 4 * * * /opt/workbench/backup.sh >> /opt/workbench/backups-host/cron.log 2>&1`
- 停止：`docker compose -f docker-compose.prod.yml down`

> 证书由 Caddy 自动续期，无需手动管；证书存在命名卷 `caddy_data`，容器重建不丢。
> 调试期若反复申请证书触发 Let's Encrypt 限额，可在 `Caddyfile` 全局块临时启用 `acme_ca` 的 staging 地址（文件内已注释说明）。

---

## 三、公网访问（域名 + HTTPS，手动/自定义反代可选）

> 上面「一键上云版」已经用 Caddy 把 HTTPS 全自动搞定了；本节是给你**不想用 docker-compose 里的 Caddy**、或要自己控 nginx 时的备选方案。

**不要让 8000 端口裸奔到公网**。用反向代理做 TLS 终止，并执行以下加固：

### 方案 A：Caddy（自动申请/续期 Let's Encrypt 证书，最简单）

`Caddyfile`：

```
workbench.example.com {
    reverse_proxy localhost:8000
}
```

```bash
caddy run --config Caddyfile
```

### 方案 B：Nginx

**不要让 8000 端口裸奔到公网**。用反向代理做 TLS 终止，并执行以下加固：

### 方案 A：Caddy（自动申请/续期 Let's Encrypt 证书，最简单）

`Caddyfile`：

```
workbench.example.com {
    reverse_proxy localhost:8000
}
```

```bash
caddy run --config Caddyfile
```

### 方案 B：Nginx

```nginx
server {
    listen 443 ssl;
    server_name workbench.example.com;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE 长连接需要关闭缓冲
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

> ⚠️ **SSE（实时同步）对代理的要求**：必须关闭响应缓冲、调大读取超时（如上），否则实时推送会被缓冲、延迟甚至断开。

部署后，所有设备（网页 / 后续打包的桌面客户端）都填同一个 `https://workbench.example.com` 即可多端互通。

---

## 四、安全与运维（给别人用必看）

- **密码**：服务端用 PBKDF2-SHA256（20 万次）加盐存储，token 存于 `users` 表，有效期 30 天，可 `POST /api/auth/refresh` 续期。
- **开放注册策略**：默认公开注册。给别人用建议 `REGISTER_OPEN=0` + `REGISTER_REQUIRE_INVITE=1` + `INVITE_CODES=...`，把邀请码发给要的人；也可全程 `REGISTER_OPEN=0` 由管理员在后台手动管。
- **限流**：注册/登录每个 IP 10 分钟内最多 30 次；GitHub 搜索每个 IP 每分钟最多 90 次。超限返回 `429`。
- **自动备份**：后端每 `BACKUP_INTERVAL` 秒把 `wb.db` 复制为 `backups/wb-<UTC时间戳>.db`，保留最近 7 份。也可 `POST /api/admin/backup` 手动触发。
- **管理后台**（需 `ADMIN_TOKEN`）：
  - `GET  /api/admin/stats` —— 用户数、同步数、邀请码用量、库大小等
  - `GET  /api/admin/users` —— 用户列表
  - `POST /api/admin/set-register {"open":true|false}` —— 实时开/关公开注册
  - `POST /api/admin/reset-token {"username":"x"}` —— 重置某用户 token（强制其下线）
  - `POST /api/admin/backup` —— 立即备份
  - 调用时带请求头 `X-Admin-Token: <ADMIN_TOKEN>`
- **GitHub 代理**：服务端需能访问外网；若服务器无外网/无代理，搜索会返回友好提示，不影响账号与同步。
- **数据隔离**：当前所有账号共享一个 `wb.db`，按 `uid` 隔离各自数据。

---

## 五、已知边界（MVP）

- 同步冲突策略为**记录级 last-write-wins + 删除墓碑**，离线分叉后能收敛；同一记录的“同秒并发编辑”按 `deviceId` 决定胜负（确定性收敛）。
- 服务端是“哑存储”，合并在客户端完成；极端并发双写可能短暂以最后到达者为准，下次同步即一致。
- 桌面客户端见 `src-tauri/`（Tauri 工程），在本机执行 `cargo tauri build` 生成安装包；另有 pywebview 原生壳 `app.py` 可直接打包成 `.exe`。
- 限流为内存级，重启即清空；多副本部署时各副本独立计数（MVP 足够，后续可换 Redis）。
