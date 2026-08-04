# Cloudflare Pages 部署说明

把「我的工作台」搬到 Cloudflare Pages：前端静态资源 + `/api/*` Pages Functions **同域**部署。
前端 `fetch("/api/...")` 用的是相对路径，因此**一行都不用改，也不需要 CORS**。

Python 版（`server.py` + `supabase_store.py`）保留作离线备份方案，不受本次迁移影响。

---

## 1. Cloudflare Pages 后台构建设置

| 项 | 值 |
|---|---|
| Framework preset | `None` |
| Build command | `npm run build:pages` |
| Build output directory | `_site` |
| Root directory | `/`（仓库根） |
| Functions directory | `functions`（Pages 自动识别，无需配置） |

仓库根的 `wrangler.toml` 里已声明 `pages_build_output_dir = "_site"`，
它会覆盖后台的 "Build output directory" 设置，两边保持一致即可。

构建脚本 `scripts/build-pages.mjs` 做的事：
1. `workbench.html` → `_site/index.html`（**构建时**生成，仓库里不再保留重复副本）
2. 复制 `icon.png` / `icon.ico` / `32x32.png` / `128x128.png` / `128x128@2x.png`
3. 写 `_site/_headers`，给 HTML 加 `Cache-Control: no-store`（防「改了没生效」）

> 单一真相原则：线上只有 `/` 这一个前端入口，不再输出 `_site/workbench.html`。
> 历史上「仓库里同时躺着 index.html 和 workbench.html 两份副本」导致过严重的
> 「改了代码却没生效」事故，这里从构建层面根除。

---

## 2. 环境变量清单

在 **Cloudflare Pages → 你的项目 → Settings → Environment variables** 配置。
Production 和 Preview 两套环境**都要配**（Preview 可以指向另一个 Supabase 项目）。

### 必需

| 变量 | 类型 | 说明 |
|---|---|---|
| `SUPABASE_URL` | Plaintext | 例：`https://xxxxxxxx.supabase.co`（结尾有无斜杠都行） |
| `SUPABASE_ANON_KEY` | Plaintext | **登录硬依赖**。口令校验靠它调 GoTrue `sign_in_with_password`；不配则所有登录必然 401 |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** | 服务端读写 + Admin API，绝不下发前端 |
| `WORKBENCH_JWT_SECRET` | **Secret** | 自签 JWT 的 HS256 密钥，32+ 位随机串 |

> ⚠️ `WORKBENCH_JWT_SECRET` **绝不能**复用 `SUPABASE_JWT_SECRET`。
> 代码里也**没有**"缺失就回退 SUPABASE_JWT_SECRET"的逻辑 —— 没配就直接 500 报错。
> 迁移时请把 Python 侧 `.env` 里现有的 `WORKBENCH_JWT_SECRET` **原样搬过来**，
> 否则已经发出去的 token 全部失效，所有设备需要重新登录。

### 可选

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `REGISTER_OPEN` | Plaintext | `1` | `1` 开放注册，其他值一律视为关闭 |
| `REGISTER_REQUIRE_INVITE` | Plaintext | `0` | `1` 表示注册必须带邀请码 |
| `ADMIN_TOKEN` | **Secret** | 空 | 不设则 `/api/admin/*` 全部 403。请求时放在请求头 `X-Admin-Token` |
| `GH_TOKEN` | **Secret** | 空 | GitHub 搜索提额到 5000/h；不设也能用（匿名 10/min） |
| `WORKBENCH_AUTH_EMAIL_DOMAIN` | Plaintext | `users.workbench.invalid` | 合成邮箱域名。**改了老账号就登不上了**，除非同步改 Supabase Auth 里的邮箱 |

### 不迁移（配了也没用，别配）

`GH_PROXY`、`HTTPS_PROXY`、`HTTP_PROXY`（Worker 在边缘节点，直连 GitHub 无碍）
`SUPABASE_DNS_BYPASS`（Clash fake-IP DNS 绕过，仅本机需要）
`PORT`、`DATA_DIR`、`WB_ENV`、`STORAGE_BACKEND`、`BACKUP_INTERVAL`、`BACKUP_KEEP`、`OPEN_BROWSER`
`QQ_APP_ID` / `QQ_APP_SECRET` / `WECHAT_APP_ID` / `WECHAT_APP_SECRET`（OAuth 端点未迁移）
`SUPABASE_JWT_SECRET`（安全上明确禁止复用）
`INVITE_CODES` —— 见下方 ⚠️

> ⚠️ **`INVITE_CODES` 是个陷阱**：这个变量只在 SQLite 分支的 `init_db()`（`server.py` L329）
> 里被读取并灌库，**Supabase 模式下从来不会被读取**。也就是说 Python 版在 Supabase
> 模式下配了它也没用，TS 版同理。
>
> 邀请码请**直接 INSERT 进 `public.invites` 表**：
> ```sql
> insert into public.invites (code, created_at)
> values ('wb-aaa', extract(epoch from now())::bigint),
>        ('wb-bbb', extract(epoch from now())::bigint)
> on conflict (code) do nothing;
> ```

---

## 3. 端点清单

### 本次迁移的 12 个（非同步类）

| 路由 | 方法 | 文件 | 备注 |
|---|---|---|---|
| `/api/health` | GET | `functions/api/health.ts` | |
| `/api/config` | GET | `functions/api/config.ts` | `pid: 0`、`workdir: "cloudflare-pages"` |
| `/api/auth/signup` | POST | `functions/api/auth/signup.ts` | |
| `/api/auth/login` | POST | `functions/api/auth/login.ts` | 不 bump token_epoch（多端登录不互踢） |
| `/api/auth/refresh` | POST | `functions/api/auth/refresh.ts` | 前端从未调用，死接口 |
| `/api/auth/logout` | POST | `functions/api/auth/logout.ts` | |
| `/api/github/search` | GET | `functions/api/github/search.ts` | 透传 `X-RateLimit-*` |
| `/api/admin/stats` | GET | `functions/api/admin/stats.ts` | |
| `/api/admin/users` | GET | `functions/api/admin/users.ts` | |
| `/api/admin/set-register` | POST | `functions/api/admin/set-register.ts` | **501**，见下 |
| `/api/admin/reset-token` | POST | `functions/api/admin/reset-token.ts` | |
| `/api/admin/backup` | POST | `functions/api/admin/backup.ts` | **501**，见下 |

### 同步类 3 个（另有负责人）

`/api/sync/pull`、`/api/sync/push`、`/api/sync/stream` → `functions/api/sync/`

### 明确不迁移的 6 个 OAuth 端点

`/api/auth/{qq,wechat}/{login,callback,result}`。原因：

- 配置从未开启（`wb.env` 里 4 个 APP_ID/SECRET 全是注释）→ `/api/config` 恒返回
  `qq_login: false` → 前端 `#lgQQ` / `#lgWX` 按钮本来就是隐藏的；
- `server.py:778` 和 `:811` 调 `_send_json(302, "", headers=...)`，但该函数第三个参数
  实际叫 `extra_headers` → **成功路径 100% TypeError**；
- `server.py:796` 的 `INSERT INTO users(password_hash, ...)` 写了一个建表语句里
  **不存在的列**。

结论：这是坏的死代码，不迁移。

---

## 4. 两个返回 501 的端点

### `/api/admin/set-register`

Python 版靠 `global REGISTER_OPEN` 改进程内可变全局（`server.py` L1023）。
Cloudflare Workers 没有常驻进程、请求可能落在不同边缘节点、`env` 只读，
运行时开关**根本无法生效**。与其返回 200 骗人，不如返回 501 说清楚。

**正确做法**：改 Pages 环境变量 `REGISTER_OPEN`（`1` 开 / `0` 关）后重新部署。

### `/api/admin/backup`

Python 版 `do_backup()` 把异常吞掉只 print 一行，路由无条件返回 200 —— 备份失败也说成功。
Pages 上既没有文件系统也没有常驻线程，这一层做不了备份，所以返回 501 而不是撒谎。

**替代方案**：
1. Supabase Dashboard → Database → Backups（Pro 档自动每日备份）
2. Free 档：本地跑 `pg_dump`，或用仓库里的 `supabase/export_backup.py` 定期导 JSON
3. 想在 Cloudflare 侧留副本：接 R2 + 一个**独立 Worker** 的 Cron Trigger（见下节）

---

## 5. 定时任务 / keepalive —— Pages Functions 不支持 Cron

**结论：Cloudflare Pages Functions 不支持 Cron Triggers（`[triggers] crons`）。**

依据：Pages 的 Wrangler 配置文件有一份**封闭的**可用键清单
（inheritable：`name` / `pages_build_output_dir` / `compatibility_date` /
`compatibility_flags` / `send_metrics` / `limits` / `placement` / `upload_source_maps`；
non-inheritable：`vars` / `d1_databases` / `durable_objects` / `hyperdrive` /
`kv_namespaces` / `queues.producers` / `r2_buckets` / `vectorize` / `services` /
`analytics_engine_datasets` / `ai`），`triggers` / `crons` **不在其中**；
文档同时明确 Workers 专属键（如 `main`）不适用于 Pages。
Pages Functions 也没有 `scheduled` 事件入口 —— 文件路由只导出 `onRequest*`。

所以本仓库**没有** `functions/_scheduled.ts`，也没有在 `wrangler.toml` 里写 `[triggers]`。
Python 版的 `_keepalive_loop`（`server.py` L1164，每 12h 一次轻查询，
用于绕开 Supabase 免费档「7 天无活动自动暂停」）需要用下面任一方式替代：

**方案 A（推荐）：独立 Worker + Cron Trigger**

新建一个独立的 Worker 项目（不是 Pages），`wrangler.toml`：

```toml
name = "workbench-keepalive"
main = "src/index.ts"
compatibility_date = "2026-08-01"

[triggers]
crons = ["0 */12 * * *"]
```

```ts
export default {
  async scheduled(_event: ScheduledEvent, env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }) {
    const url = env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/profiles?select=uid&limit=1';
    await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
      },
    });
  },
};
```

**方案 B：外部定时器**
用 cron-job.org / UptimeRobot 每 12 小时打一次 `https://<你的域名>/api/health`。
注意 `/api/health` **不查库**（它只回报 GH_TOKEN 配置状态），所以这条**不足以**给
Supabase 保活；要保活得打一个真正会查库的端点，例如带 `X-Admin-Token` 的
`/api/admin/stats`。

**方案 C：迁到 Workers Static Assets**
Cloudflare 现在推荐用「Workers + 静态资源」替代 Pages，那条路径**支持** Cron Trigger，
可以把静态托管、API、定时任务合并到一个 Worker 里。属于后续可选的架构演进。

---

## 6. 本地开发

```bash
npm install
npm run build:pages          # 生成 _site/
npm run typecheck            # tsc，零错误
npm test                     # 单元测试
npm run pages:dev            # wrangler pages dev _site（含 functions/ 路由）
```

`wrangler pages dev` 读取项目根的 `.dev.vars` 作为本地环境变量（格式同 `.env`）。
**`.dev.vars` 含密钥，必须加进 `.gitignore`**（当前 `.gitignore` 里的 `*.env` 不覆盖它，
已单独加了一行）。

```
# .dev.vars 示例（不要提交）
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
WORKBENCH_JWT_SECRET=...
ADMIN_TOKEN=...
```

---

## 7. 与 Python 版的行为差异一览

| 项 | Python (`server.py`) | Cloudflare Pages |
|---|---|---|
| 进程内限流 `RateLimiter` | 有（auth 30/10min、gh 90/min per IP） | **不实现**。防线交给 Supabase Auth 和 GitHub 自身限流 |
| `token_epoch` 60s 缓存 | 有（`_epoch_cache`） | **不缓存**，每次直查库（约 20ms）。顺带修好「reset-token 后撤销最长延迟 60s」 |
| `REGISTER_OPEN` 运行时可改 | 是（`global`） | 否，只读环境变量 |
| 定时备份线程 | 有 | 无（501） |
| keepalive 线程 | 有（12h） | 无，见第 5 节 |
| GitHub 出网代理 / winreg 探测 | 有（约 220 行） | **不迁移**，边缘节点直连 |
| Supabase DoH DNS 绕过 | 有 | **不迁移** |
| SQLite 兜底 + PBKDF2 20 万轮 | 有 | **不迁移**（Worker 免费档 10ms CPU 必超时；口令校验全交给 Supabase Auth） |
| 无 `GH_TOKEN` 时的 GitHub 搜索 | 前置返回 502 | 正常匿名代理（10 次/分钟） |
| `/api/config` 的 `pid` / `workdir` | 真实 PID / 目录 | `0` / `"cloudflare-pages"` |
| `/api/admin/stats` 的 `db_size_bytes` / `backup_dir` | 真实值 | `0` / `""` |
| 异常时的响应体 | 可能是 Python 500 HTML | **始终是 JSON** |

---

## 8. 迁移后的自检清单

```bash
BASE=https://<你的域名>

curl -s $BASE/api/health
# 期望: {"ok":true,"github_proxy":...,"proxy":...}

curl -s $BASE/api/config
# 期望: 含 app/version/pid/workdir/register_open/register_require_invite/
#       github_proxy/github_proxy_detail/qq_login/wechat_login 共 10 个字段

curl -s "$BASE/api/github/search?q=vue&per_page=1" -D- -o/dev/null | grep -i ratelimit
# 期望: 能看到 x-ratelimit-limit / x-ratelimit-remaining（前端要读）

curl -s -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
     -d '{"username":"<你的用户名>","password":"<口令>"}'
# 期望: {"token":"eyJ...","username":"..."}

curl -s $BASE/api/admin/stats -H "X-Admin-Token: $ADMIN_TOKEN"
# 期望: 200（Python 的 Supabase 分支这里必然 500，已修）

curl -s $BASE/api/nope
# 期望: {"error":"not found"}，而不是一坨 HTML
```

浏览器里再点一次前端「GitHub 搜索」旁边的**连接自检**按钮，
四项应该全绿（②会显示 `PID ?` 和 `目录 cloudflare-pages`，属正常）。
