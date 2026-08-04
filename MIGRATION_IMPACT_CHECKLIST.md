# 迁移影响清单（Migration Impact Checklist）

> **状态**：只读扫描完成 · **尚未修改任何代码** · **尚未创建 Supabase 项目** · **尚未迁移数据** · **旧 SQLite 架构保留作备份**
> **下一步**：用户确认下方 10 个决策点后，才进入 Phase 1（Supabase 设计）
> 生成方式：CloudQ 对 `E:\project\workbench` 全量文件静态扫描 + 数据流追踪

---

## 一、扫描范围与结论

| 维度 | 结论 |
|------|------|
| 产品功能 | 不改 |
| 数据模型 | 不改（payload 单 JSON 文档结构保留） |
| 前端 UI | 目标 0 改动；但 B1 需豁免 1 行（见下） |
| 后端 server.py | 保留为业务层，仅替换存储底座（SQLite → Supabase） |
| 客户端 | Windows / Android 仅改「指向云端 server.py」 |
| 迁移后回滚 | 旧 `server.py` + `wb.db` 全程保留，可一键回退 |

**数据模型真相（已实读确认）**：SQLite 仅 3 张表 `users` / `sync` / `invites`；**全部业务数据（times/ideas/notes/diary/cog_reads/books/thoughts/reviews/directions/reviews/settings）都存在于 `sync.payload` 这一个 JSON 文档内**，按 uid 行级隔离。行内记录本身不带 uid，跨端合并靠 `deviceId`（localStorage `wb_dev`）做字典序 tie-break。`merge_records`（server.py L352-371）是记录级 LWW 合并（按 `updatedAt`，同值比 `deviceId`），`settings` 做键级合并。

---

## 二、阻断性发现（BLOCKING — 必须决策）

### 🔴 B1：前端 SSE 实时同步实际失效
- `workbench.html:2850` → `new EventSource("/api/sync/stream")`
- 浏览器 `EventSource` **无法携带 Authorization Bearer 头**，但 `server.py:954-958` 的 `sync_stream` 要求 Bearer 校验，否则返回 **401**。
- 含义：**当前「实时多端同步」根本没在工作**——只有主动 pull/push 才同步，别人改了你不会即时收到。
- 修复：改 1 行前端（`EventSource` 改为带 token 的自有 SSE 实现，或 server.py 改用 cookie/query 鉴权）。
- 冲突：与「不改前端」约束冲突 → **需用户豁免这 1 行改动**。

### 🔴 B2：Token 有效期契约冲突
- 前端契约：30 天长效 token（`server.py` `TOKEN_TTL = 60*60*24*30`，L141）。用户登录一次管一个月。
- Supabase Auth JWT：**1 小时**过期。
- 方案 A（推荐，0 前端改动）：server.py 继续**自签 30 天不透明 token**，Supabase Auth 仅用于密码校验，不向前端下发 JWT。
- 方案 B：前端改为持 Supabase JWT + 刷新逻辑（需改前端多行）。

### 🔴 B3：旧密码哈希无法迁移到 Supabase Auth
- 现有：`PBKDF2-HMAC-SHA256` / 200000 轮（`users` 表，仅 1 个用户 `糊糊`，非邮箱账号）。
- Supabase Auth 用 **bcrypt**，旧 verifier 不可导入。
- 推荐：**重置该用户密码**（仅 1 个用户，代价极小）；平滑备选：双认证过渡（先试 Supabase，失败回退旧表并自动置备 Supabase 账号，原密码零中断）。

### 🔴 B4：进程锁 → 行锁在 supabase-py 下不可行
- 现有并发保护是**进程内锁**（单进程够用）。多实例/重启时丢更新。
- supabase-py **没有跨请求事务**，无法做 `SELECT … FOR UPDATE` 行锁。
- 必须改用 **乐观锁 CAS**：`payload_version` 自增 + 更新时校验版本，冲突则重读+重合并。契合「不写 DB 函数」约束（不翻译为 PL/pgSQL）。

### 🔴 B5：QQ / 微信 OAuth 代码本身有 bug
- `server.py` 的 QQ/微信登录分支存在多处硬伤（约 L719 / L736 / L737 / L739 / L752 附近：回调校验、state 校验、token 换取均有错）。
- 现有代码**根本跑不通**，属于死代码。
- 推荐：**直接移除**（Alpha 个人版用不到第三方登录），或修复（额外工作量，非必需）。

---

## 三、受影响文件清单与改动量估计

**修改类（约 13 个文件，~560–640 行）**
| 文件 | 改动 | 估计行数 |
|------|------|---------|
| `server.py` | 替换存储层为 Supabase 客户端；保留 API/merge/sync/校验；加 JWT/IO；泛化 merge_records；乐观 CAS | ~390–460（约 40%） |
| `app.py` | 移除本地 SQLite server 拉起（约 -170 行），WebView 直连云端域名（约 +25 行） | ~-145 净 |
| `android/.../MainActivity.java` | 仅填 `BACKEND_URL` 真实域名；`network_security_config.xml` `cleartextTrafficPermitted` 改 false | ~3 |
| `Dockerfile` | 零依赖 → 加 `requirements.txt`（supabase / PyJWT） | ~5 |
| `docker-compose.prod.yml` | 加 `SUPABASE_URL` / `SUPABASE_ANON` / `SUPABASE_SERVICE_ROLE` / `SUPABASE_JWT_SECRET` 4 个环境变量 | ~4 |
| `deploy.sh` | 校验 SUPABASE_* 必填 | ~10 |
| `backup.sh` | 迁移后语义失效，改为 Supabase JSON 导出或留空 | ~重写 |
| `README.deploy.md` | 重写 Supabase 相关章节 | ~重写 |
| `workbench.html` | **仅 B1 豁免的 1 行**（其余 0 改动） | ~1 |
| `index.html` | 随 `workbench.html` `cp` 同步（字节一致） | 0 实质 |
| `.env.example` | 加 SUPABASE_* 4 项 | ~4 |

**新增类（4–5 个文件，~500 行）**
| 文件 | 用途 | 估计行数 |
|------|------|---------|
| `supabase/schema.sql` | `sync` / `profiles` / `invites` 表 + RLS + 索引 | ~70 |
| `supabase_store.py` | Supabase 存储访问层（封装 supabase-py；乐观 CAS；payload 读写） | ~250 |
| `migrate_sqlite_to_supabase.py` | wb.db → Supabase 一次性迁移脚本（含校验） | ~180 |
| `requirements.txt` | `supabase` + `PyJWT` | ~4 |
| `server_sqlite.py.bak` | 旧 server.py 整文件备份（1095 行，不删） | 1095 |

**总计**：修改 ~560–640 行 + 新增 ~500 行（含备份）。

---

## 四、10 个待确认决策点

> ✅ = 推荐默认；进入 Phase 1 前请逐条确认或覆盖。

1. **【B2 Token】** ✅ A：server.py 自签 30 天不透明 token，Supabase Auth 仅做密码校验（0 前端改动）。备选 B：前端改持 Supabase JWT + 刷新。
2. **【B1 SSE】** ✅ 豁免「不改前端」约束，修 `workbench.html:2850` 这 1 行，让实时同步真正生效。备选：维持现状（实时同步继续失效）。
3. **【B3 密码】** ✅ 重置用户 `糊糊` 密码（仅 1 人）；备选：双认证平滑迁移（零重置）/ magic link。
4. **【B4 并发】** ✅ 乐观锁 CAS（靠 `payload_version`，不写 DB 函数）。备选：psycopg 真实事务（需引入 psycopg + DB 函数，违反「不拆表/不写函数」倾向）。
5. **【B5 OAuth】** ✅ 移除 QQ/微信登录死代码（Alpha 用不到）。备选：修复 / 保留。
6. **【Realtime】** ✅ 暂缓接入 Realtime，单实例 + 现有 `notify()` 已够；Phase 5 改为预留接口。备选：Phase 5 即接入 Realtime 作通知骨干。
7. **【updated_at 类型】** ✅ 用 `bigint`（Unix 秒），与前端 0 改动契约一致。备选：`timestamptz`（需前端适配）。
8. **【uid 主键】** ✅ 旧 32-hex uid → 改用 Supabase `auth.users` 的 uuid 作主键，旧 uid 存入 `legacy_uid` 列保留追溯。备选：强行沿用旧 hex（破坏 Supabase Auth 关联）。
9. **【备份策略】** ✅ 周期性 Supabase → JSON 导出（替代原 `do_backup` / `backup.sh` 本地 tar）。备选：依赖 Pro 档 PITR / 关闭备份。
10. **【index.html 冗余】** ✅ 保留 `index.html` 作为 `workbench.html` 字节级镜像（防历史坑）。备选：删除 `index.html` 仅留唯一真相。

---

## 五、执行前需用户提供的环境信息

| 项 | 用途 |
|----|------|
| Supabase 项目 URL | 连接后端 |
| anon key | 服务端只读/客户端（本项目服务端用） |
| service_role key | 服务端特权读写（迁移、置备账号） |
| JWT secret | server.py 自签 token 校验（若选 B2-A） |
| 用户 `糊糊` 的真实邮箱 | 建 Supabase Auth 账号（推荐真实邮箱） |
| Supabase 区域 | 选离用户近的（如 ap-southeast-1 / 美西） |
| 服务器 + 域名就绪 | Caddy 自动 HTTPS 所需（80/443 可达 + 域名解析） |
| GitHub Token（GH_TOKEN） | 保留 GitHub 代理能力 |
| ADMIN_TOKEN | 管理后台鉴权 |

---

## 六、执行顺序回顾（Phase 1–9，确认后开始）

- **Phase 1** Supabase 设计（Auth 配置 / PostgreSQL 表 / RLS / Realtime 预留）
- **Phase 2** 改 `server.py`（接 Supabase 存储层，保留 API/merge/sync，加乐观 CAS）
- **Phase 3** 账号系统迁移（Supabase Auth + `profiles` 映射，平滑或重置）
- **Phase 4** 数据迁移（`wb.db` → Supabase，脚本 + 校验）
- **Phase 5** 同步升级（SSE 保留；Realtime 按决策点 6 决定）
- **Phase 6** Windows 迁移（`app.py` 去本地 server 拉起）
- **Phase 7** Android 迁移（填 `BACKEND_URL`，重出 APK）
- **Phase 8** 完整测试（Win↔Android 同步 / 并发编辑 / 离线恢复 / 全模块）
- **Phase 9** 上线切换（旧 SQLite 保留兜底，写回滚说明）

---

*本清单为只读产物，任何代码修改须待上方 10 决策点确认后从 Phase 1 启动。*
