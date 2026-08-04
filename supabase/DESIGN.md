# workbench × Supabase 混合架构设计（Phase 1）

> **状态**：设计文档 · **未修改任何现有代码** · **未创建 Supabase 项目** · **未迁移数据**
> **产物**：本文件 + `supabase/schema.sql`（可直接粘贴到 Supabase SQL Editor 执行）
> **上游依据**：`MIGRATION_IMPACT_CHECKLIST.md` 的 10 个决策点（用户已全部采纳推荐默认值）
> **代码事实来源**：实读 `server.py`（1095 行）、`workbench.html` 同步段（L2805–2855）

---

## 一、范围与不变式

### 1.1 分层职责

```
┌──────────────────────────────────────────────────────────────┐
│  客户端  Windows WebView2 (app.py)  /  Android WebView        │
│  workbench.html（= index.html 字节镜像）                       │
│  契约：Bearer token（30 天） · /api/sync/pull|push|stream      │
└───────────────────────────┬──────────────────────────────────┘
                            │  HTTPS，仅此一条链路
┌───────────────────────────▼──────────────────────────────────┐
│  server.py（业务层 · 唯一保留的自研后端）                       │
│  · API 路由 / 参数校验 / 限流                                  │
│  · merge_records 记录级 LWW 合并（1:1 保留）                    │
│  · 自签 30 天 Bearer JWT（PyJWT HS256）                        │
│  · SSE 广播 notify() → /api/sync/stream                       │
│  · GitHub 代理 / 管理后台 / 未来 AI 能力                        │
│  · 乐观锁 CAS 重试循环                                         │
└───────────────────────────┬──────────────────────────────────┘
                            │  service_role key（服务端专用）
┌───────────────────────────▼──────────────────────────────────┐
│  Supabase（仅三件事）                                          │
│  ① Auth      —— 只做「密码校验 + 用户身份」                     │
│  ② Postgres  —— jsonb 单文档存储（sync / profiles / invites）  │
│  ③ Realtime  —— 【Phase 5 预留，本期不接入】                    │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 硬性不变式（本设计的验收线）

| 不变式 | 说明 |
|--------|------|
| 客户端永不直连 Supabase | anon key / service_role key 都**不**下发到前端；前端只认识 server.py |
| 前端 0 改动（1 行豁免） | 唯一豁免：`workbench.html:2850` 的 `EventSource`（Phase 2/5 修，本期不动） |
| `merge_records` 语义 1:1 | 合并逻辑不改一个字符，只是数据来源从 SQLite 换成 Postgres |
| `payload` 文档结构不变 | 11 个顶层键原样存 jsonb，不拆表、不建 GIN 索引 |
| 时间戳仍为 Unix 秒 | `updated_at bigint`，前端 `new Date(at*1000)` 无需适配 |
| 不写 PL/pgSQL / 不用 psycopg | 只用 supabase-py；并发靠乐观锁 CAS |
| 旧架构保留可回滚 | 旧 `server.py` + `wb.db` + `backups/` 全程不删 |

---

## 二、Auth 设计

### 2.1 Supabase Auth 项目配置

在 Supabase Dashboard → **Authentication** 中按下表设置（个人版，单用户）：

| 配置项 | 值 | 理由 |
|--------|-----|------|
| Providers → **Email** | Enabled | 唯一启用的 provider |
| Email → **Confirm email** | **OFF** | 个人版无邮件投递需求；账号由 server.py 用 Admin API 直接置备 |
| Email → Secure email change | OFF | 无邮箱变更场景 |
| **Minimum password length** | **6** | 与旧 `server.py:585`（`len(password) < 6` 拒绝）保持一致 |
| Password requirements | 无额外字符类要求 | 避免旧用户重设密码时被新规则卡住 |
| Providers → Phone / Anonymous / 第三方 | **全部 Disabled** | 决策点 5：QQ/微信 OAuth 死代码移除，不做第三方登录 |
| **Sessions → JWT expiry** | 默认 3600 即可 | Supabase 的 JWT **不下发给前端**，只在 server.py 内部用完即弃 |
| Sessions → Refresh token rotation | 默认 | 同上，server.py 登录后立刻登出该 session |
| URL Configuration → Site URL | 生产域名 | 仅影响邮件模板，个人版可留默认 |

> ⚠️ **不要**在 Supabase 侧开启任何 "allow signups from client"。所有账号创建都必须经 server.py 的 service_role Admin API。

### 2.2 用户名 ↔ 邮箱映射（关键点）

前端登录表单提交的是 **username**（当前唯一用户为 `糊糊`，非邮箱），而 Supabase Auth 的 email provider 要求 email 作为标识。映射规则：

- `profiles.auth_email` 存储该 username 对应的 Supabase Auth 邮箱。
- 若用户提供了真实邮箱 → 直接使用（可用官方找回密码流程）。
- 否则使用**确定性合成邮箱**，保证同一 username 永远映射到同一地址：

```python
import hashlib

AUTH_EMAIL_DOMAIN = os.environ.get("WORKBENCH_AUTH_EMAIL_DOMAIN", "users.workbench.invalid")

def derive_auth_email(username: str) -> str:
    """username -> 稳定的合成邮箱；username 可含中文，故先做 sha256 再取 hex。"""
    h = hashlib.sha256(username.encode("utf-8")).hexdigest()[:24]
    return "u%s@%s" % (h, AUTH_EMAIL_DOMAIN)
```

- 登录流程只用 `profiles.username` 查出 `auth_email`，再拿 `auth_email + password` 去 Supabase 验证。
- 合成邮箱域名用 `.invalid`（RFC 2606 保留后缀），确保永远不会有真实邮件被误发。
- **`糊糊` 这一个账号建议直接填真实邮箱**（决策点 3 已同意重置密码，顺手把邮箱补上，后续可自助找回）。

### 2.3 注册流程（`POST /api/auth/signup`，前端契约不变）

```
前端 → server.py: {username, password, invite?}
  1. server.py 校验：REGISTER_OPEN / 用户名密码非空 / len(password) >= 6
  2. 若 REGISTER_REQUIRE_INVITE：select invites where code=? and used_by is null
  3. 查重：select 1 from profiles where username = ?      → 409「用户名已存在」
  4. auth_email = 真实邮箱 or derive_auth_email(username)
  5. Supabase Admin API 建号（service_role）：
     sb_admin.auth.admin.create_user({
        "email": auth_email,
        "password": password,
        "email_confirm": True,                 # 跳过确认邮件
        "user_metadata": {"username": username}
     })                                        → 得到 uid (uuid)
  6. insert profiles(uid, username, auth_email, legacy_uid=NULL,
                     token_epoch=now, created_at=now)
  7. insert sync(uid, payload='{}', payload_version=0, updated_at=0)
  8. 若用了邀请码：update invites set used_by=uid, used_at=now where code=?
  9. token = issue_token(uid, username, token_epoch)
server.py → 前端: {"token": token, "username": username}      # 与旧版完全一致
```

**失败补偿**：若第 6/7 步失败，必须回滚第 5 步（`sb_admin.auth.admin.delete_user(uid)`），否则会留下孤儿 Auth 用户导致下次注册报「邮箱已存在」。

### 2.4 登录流程（`POST /api/auth/login`，前端契约不变）

```
前端 → server.py: {username, password}
  1. 限流（沿用现有 auth_limiter：10 分钟 30 次/IP）
  2. row = select uid, auth_email, token_epoch from profiles where username = ?
     → 不存在：返回 401「用户名或密码错误」（不泄漏用户是否存在）
  3. 用 anon key 客户端做密码校验：
     sess = sb_anon.auth.sign_in_with_password({"email": row.auth_email,
                                                "password": password})
     → 抛异常 / 无 session：401「用户名或密码错误」
  4. 立即销毁这个 Supabase session（不下发给前端）：
     sb_anon.auth.sign_out()          # 或 POST /auth/v1/logout
  5. token = issue_token(row.uid, username, row.token_epoch)
server.py → 前端: {"token": token, "username": username}
```

要点：
- Supabase 返回的 `access_token`（1 小时）/ `refresh_token` **绝不外泄**，用完立刻 `sign_out`，避免 refresh token 无限堆积。
- 每次登录用**独立的 anon client 实例**（或调用后 `sign_out`），防止 supabase-py 的 client 级 session 污染并发请求。
- 旧逻辑「token 未过期则复用旧 token」（`server.py:626-635`）在无状态 JWT 下**改为每次登录签发新 token**。前端只存最新的那个，旧 token 在 30 天内仍可用——这与旧行为的差异仅在于「同一账号可同时持有多个有效 token」，对多端登录场景反而更友好。

### 2.5 自签 30 天 Token（决策点 1 · 方案 A）

**签名密钥**：

```python
JWT_SECRET = (os.environ.get("WORKBENCH_JWT_SECRET")
              or os.environ.get("SUPABASE_JWT_SECRET") or "").strip()
```

> 🔴 **安全强约束**：**强烈建议配置独立的 `WORKBENCH_JWT_SECRET`**，不要复用 `SUPABASE_JWT_SECRET`。
> 原因：Supabase 的 PostgREST / Storage / Realtime 都用 `SUPABASE_JWT_SECRET` 验签。如果我们用同一把密钥自签 token，一旦 token 里出现 `role` / `aud=authenticated` 之类的 claim，就可能被 Supabase 直接当作合法凭证接受，形成**越权通道**。
> 缓解手段（两条同时做）：① 用独立密钥；② 我方 token 固定 `iss="workbench"` / `aud="workbench-client"`，且**永不签发 `role` claim**。

**签发**：

```python
import jwt, time, secrets   # PyJWT>=2.8

TOKEN_TTL = 60 * 60 * 24 * 30       # 30 天，与 server.py:141 一致
JWT_ISS   = "workbench"
JWT_AUD   = "workbench-client"

def issue_token(uid: str, username: str, token_epoch: int) -> str:
    now = int(time.time())
    return jwt.encode({
        "iss": JWT_ISS,
        "aud": JWT_AUD,
        "sub": uid,                 # auth.users.id (uuid)
        "usr": username,
        "epo": token_epoch,         # 撤销世代号，见 2.6
        "iat": now,
        "exp": now + TOKEN_TTL,
        "jti": secrets.token_hex(8),
        "v":   1,                   # 载荷版本，便于未来平滑升级
    }, JWT_SECRET, algorithm="HS256")
```

**校验**（替换 `server.py:325 auth_user()`，保持函数签名 `token -> uid | None`）：

```python
def auth_user(token: str):
    if not token:
        return None
    try:
        claims = jwt.decode(
            token, JWT_SECRET,
            algorithms=["HS256"],           # 显式钉死算法，防 alg=none / RS256 混淆
            audience=JWT_AUD, issuer=JWT_ISS,
            options={"require": ["exp", "sub", "iat"]},
        )
    except jwt.PyJWTError:
        return None
    uid = claims.get("sub")
    if not uid:
        return None
    if claims.get("epo", 0) < get_token_epoch(uid):   # 撤销检查，见 2.6
        return None
    return uid
```

**前端影响**：`{"token": ..., "username": ...}` 响应体不变；token 从 64 位 hex 变成 ~300 字符 JWT，前端只是原样存 `localStorage` 再回传，**0 改动**。

### 2.6 撤销语义（logout / refresh / admin reset-token）

无状态 JWT 天然不可撤销，但旧实现的三个接口都依赖「清库里的 token 即刻失效」。用 `profiles.token_epoch`（bigint，单调递增）复刻：

| 接口 | 旧行为（SQLite） | 新行为（Supabase） |
|------|-----------------|-------------------|
| `POST /api/auth/logout` | `UPDATE users SET token=NULL` | `UPDATE profiles SET token_epoch = now` → 所有旧 token 立即失效 |
| `POST /api/auth/refresh` | 生成新 token，旧 token 立即失效 | 先 `token_epoch = now`，再用新 epoch 签发新 token |
| `POST /api/admin/reset-token` | `UPDATE users SET token=NULL WHERE username=?` | `UPDATE profiles SET token_epoch = now WHERE username=?` |

**性能**：`get_token_epoch(uid)` 若每个请求都查库会给 Supabase 增加一次 RTT。方案：**进程内缓存 60 秒**。

```python
_epoch_cache = {}          # uid -> (epoch, cached_at)
_EPOCH_TTL = 60

def get_token_epoch(uid: str) -> int:
    hit = _epoch_cache.get(uid)
    now = time.time()
    if hit and now - hit[1] < _EPOCH_TTL:
        return hit[0]
    r = sb.table("profiles").select("token_epoch").eq("uid", uid).limit(1).execute()
    epoch = (r.data[0]["token_epoch"] if r.data else 0)
    _epoch_cache[uid] = (epoch, now)
    return epoch

def bump_token_epoch(uid: str) -> int:
    epoch = int(time.time())
    sb.table("profiles").update({"token_epoch": epoch}).eq("uid", uid).execute()
    _epoch_cache[uid] = (epoch, time.time())     # 本进程立即生效
    return epoch
```

代价：单实例下撤销立即生效；未来多实例时，其它实例最多 60 秒后才感知登出。个人版可接受，多实例时把 `_EPOCH_TTL` 调小或改走 Realtime 广播即可。

### 2.7 账号置备与 `profiles` 映射

| 场景 | 处理 |
|------|------|
| 迁移已有用户 `糊糊` | Phase 3/4 脚本：Admin API 建号（新密码）→ `profiles(uid=新uuid, username='糊糊', auth_email, legacy_uid='<旧32-hex>')` |
| 迁移后新注册用户 | `legacy_uid = NULL` |
| 追溯旧数据 | `select uid from profiles where legacy_uid = '<旧 hex>'` |
| 删号 | 删 `auth.users` 一行 → `profiles` / `sync` 经 `ON DELETE CASCADE` 自动清理 |

### 2.8 新增环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `SUPABASE_URL` | 是 | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | 是 | 仅用于 `sign_in_with_password` 做密码校验 |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | 服务端读写 + Admin API 建号（**绝不下发前端**） |
| `WORKBENCH_JWT_SECRET` | **强烈建议** | 自签 token 的 HS256 密钥（≥32 字节随机） |
| `SUPABASE_JWT_SECRET` | 否 | 上者缺失时的兜底（不推荐，见 2.5 安全说明） |
| `WORKBENCH_AUTH_EMAIL_DOMAIN` | 否 | 合成邮箱域名，默认 `users.workbench.invalid` |

Python 依赖（Phase 2 新增 `requirements.txt`）：`supabase>=2.5`、`PyJWT>=2.8`。

---

## 三、PostgreSQL Schema

完整 DDL 见 **`supabase/schema.sql`**（可直接执行、幂等）。此处为设计说明。

### 3.1 三张表

```sql
-- 业务数据：一个用户一行、一个 JSON 文档
create table public.sync (
    uid             uuid    primary key references auth.users(id) on delete cascade,
    payload         jsonb   not null default '{}'::jsonb,
    payload_version integer not null default 0,
    updated_at      bigint  not null default 0
);

-- 身份映射
create table public.profiles (
    uid         uuid   primary key references auth.users(id) on delete cascade,
    username    text   not null unique,
    auth_email  text   not null unique,
    legacy_uid  text,
    token_epoch bigint not null default 0,
    created_at  bigint not null default 0
);

-- 邀请码
create table public.invites (
    code       text   primary key,
    created_by uuid   references auth.users(id) on delete set null,
    created_at bigint not null default 0,
    used_by    uuid   references auth.users(id) on delete set null,
    used_at    bigint
);
```

### 3.2 相对 team-lead 规格的 3 处增补（需确认）

| 增补列 | 表 | 为什么必须有 |
|--------|-----|-------------|
| `auth_email text not null unique` | profiles | Supabase Auth 用 email 作标识，而前端登录用 username（`糊糊` 非邮箱）。没有这一列就无法完成 username → Auth 的映射（见 2.2） |
| `token_epoch bigint not null default 0` | profiles | 无状态 JWT 无法撤销。没有它，`logout` / `refresh` / `admin reset-token` 三个现存接口会**静默失效**（登出后旧 token 仍能用 30 天），属于安全回退（见 2.6） |
| `used_by uuid` | invites | `server.py:610` 写的就是 `used_by`；team-lead 的 DDL 只给了 `created_by`，缺 `used_by` 会让邀请码「用了也标不上已用」 |

其余列、类型、约束与规格完全一致。

### 3.3 与旧 SQLite 的字段映射

| 旧 SQLite | 新位置 | 说明 |
|-----------|--------|------|
| `users.uid` (32-hex) | `profiles.legacy_uid` | 仅作追溯；主键改用 `auth.users.id` (uuid) |
| `users.username` | `profiles.username` | 大小写敏感语义保持一致 |
| `users.salt` / `users.verifier` | **删除** | 密码交给 Supabase Auth（bcrypt）；PBKDF2 无法导入 → 重置密码（决策点 3） |
| `users.token` / `token_exp` | **删除** | 改为无状态自签 JWT + `profiles.token_epoch` 撤销 |
| `sync.uid` | `sync.uid` | TEXT → UUID |
| `sync.payload` (TEXT) | `sync.payload` (jsonb) | 结构完全不变，11 个顶层键原样 |
| `sync.updated` | `sync.updated_at` | 均为 Unix 秒；API 出参仍叫 `updated`，前端 0 改动 |
| — | `sync.payload_version` | **新增**，乐观锁用 |
| `invites.code/used_by/used_at` | 同名列 | 类型 TEXT → UUID（`used_by`） |

### 3.4 RLS 策略

**前提**：server.py 用 **service_role** 连接，`service_role` 具备 `BYPASSRLS`，所有正常读写都不受策略影响。RLS 的作用是**纵深防御**——万一 anon key 泄漏（比如未来某天误打包进前端），攻击者也读不到任何数据。

| 表 | anon | authenticated | service_role |
|----|------|---------------|--------------|
| `sync` | 全部 REVOKE，无策略 → 拒绝 | SELECT / INSERT / UPDATE，条件 `auth.uid() = uid` | 全通（bypass） |
| `profiles` | 全部 REVOKE，无策略 → 拒绝 | SELECT / UPDATE 自己那行；**无 INSERT 策略**（只能由 server.py 置备） | 全通 |
| `invites` | REVOKE + 无策略 → 拒绝 | REVOKE + 无策略 → 拒绝 | 全通 |

刻意不做的事：
- `sync` **不给 DELETE 策略** —— 数据行只随 `auth.users` 级联删除消失，杜绝误删。
- 用户名唯一性由 `UNIQUE` 约束保证，**不用 RLS 表达**（RLS 表达唯一性是反模式）。
- 不开 `FORCE ROW LEVEL SECURITY`（schema.sql 里给了注释掉的开关），避免误伤表 owner 的运维操作。

### 3.5 索引

| 索引 | 类型 | 目的 |
|------|------|------|
| `sync_pkey (uid)` | PK | 唯一访问路径：按 uid 取整个文档 |
| `profiles_username_key (username)` | UNIQUE | 登录时 username → uid 查询；同时保证唯一 |
| `profiles_auth_email_key (auth_email)` | UNIQUE | 防止两个 username 撞同一个 Auth 账号 |
| `idx_sync_updated_at (updated_at desc)` | 普通（可选） | 备份导出 / 管理后台按更新时间排序 |
| `idx_profiles_legacy_uid` | 部分索引 | 迁移期按旧 uid 追溯 |
| `idx_invites_used_at where used_at is null` | 部分索引 | 快速筛未使用邀请码 |
| ~~`gin (payload)`~~ | **不建** | 文档只按主键整存整取，GIN 只会放大每次 push 的写入成本 |

---

## 四、并发：乐观锁 CAS（决策点 4）

### 4.1 为什么

旧实现靠**进程内 `db_lock`**（`server.py:854`）串行化 push。换到 Supabase 后：
- supabase-py 走 PostgREST，**没有跨请求事务**，做不了 `SELECT ... FOR UPDATE`；
- 约束要求**不写 PL/pgSQL、不引 psycopg**。

因此用 `payload_version` 做 **Compare-And-Swap**：读版本 → 合并 → 带版本条件更新 → 冲突则重来。

### 4.2 完整流程（替换 `server.py:841 api_push`，`merge_records` 原样复用）

```python
import random, time

PUSH_MAX_RETRY = 5

# payload 的 10 个数组键，顺序与 server.py:863-876 一致
RECORD_KEYS = ["times", "ideas", "notes", "diary",
               "cog_reads", "cog_books", "cog_thoughts", "cog_reviews",
               "directions", "reviews"]
EMPTY_PAYLOAD = {**{k: [] for k in RECORD_KEYS}, "settings": {}}


def push_payload(sb, uid: str, inc: dict):
    """返回 updated(unix秒)；冲突耗尽重试则抛 CasConflict。"""
    for attempt in range(PUSH_MAX_RETRY):
        # ---- 1. 读当前版本 + 文档 ----
        r = (sb.table("sync")
               .select("payload, payload_version")
               .eq("uid", uid).limit(1).execute())

        if not r.data:
            # 行不存在：先幂等建行（并发下靠主键唯一约束兜底），下一轮再 CAS
            try:
                sb.table("sync").insert({
                    "uid": uid, "payload": EMPTY_PAYLOAD,
                    "payload_version": 0, "updated_at": 0,
                }).execute()
            except Exception:
                pass                      # 23505 duplicate key -> 别人先建了，重试即可
            continue

        cur = r.data[0]["payload"] or {}
        ver = r.data[0]["payload_version"]

        # ---- 2. 合并（与旧逻辑逐字一致，merge_records 不改） ----
        new_payload = {k: merge_records(cur.get(k) or [], inc.get(k) or [])
                       for k in RECORD_KEYS}
        new_payload["settings"] = {
            **(cur.get("settings") or {}),
            **{k: v for k, v in (inc.get("settings") or {}).items() if v},
        }
        updated = int(time.time())

        # ---- 3. CAS 写回：版本没被别人动过才生效 ----
        w = (sb.table("sync")
               .update({"payload": new_payload,
                        "payload_version": ver + 1,
                        "updated_at": updated})
               .eq("uid", uid)
               .eq("payload_version", ver)          # ← CAS 条件
               .execute())

        if w.data:                                  # 影响行数 > 0 → 成功
            return updated

        # ---- 4. 冲突：指数退避 + 抖动后重读重合并 ----
        time.sleep(min(0.4, 0.02 * (2 ** attempt)) * (0.5 + random.random()))

    raise CasConflict("payload_version conflict after %d retries" % PUSH_MAX_RETRY)
```

### 4.3 关键实现细节

1. **`w.data` 判空即冲突检测**：postgrest-py 默认 `Prefer: return=representation`，更新 0 行时 `data == []`。若某版本默认行为变了，显式加 `.execute()` 前的 `returning="representation"`，或改判 `w.count`。
2. **合并顺序必须与旧代码一致**：`{**cur_settings, **{k:v for k,v in inc_settings.items() if v}}` —— 增量里的**假值（空串/0/None）不覆盖**旧值，这是旧代码的既有语义（`server.py:875`），必须原样保留。
3. **仍然保留进程内锁作为一级削峰**：单实例下先用 `db_lock`（改名 `sync_lock`）串行化同 uid 的 push，能让 CAS 几乎永不冲突；CAS 是跨实例/重启时的正确性兜底。二者不冲突，建议都留。
4. **重试耗尽的返回**：返回 HTTP 409 + `{"error": "..."}`。前端 `pushSync()`（`workbench.html:2838-2842`）对非 200 的处理是「不更新 `wb_sync_at` 并原样返回 JSON」，**不会崩、不会丢本地数据**，下一次 `scheduleSync()`（800ms 防抖）会自然重试 → 前端仍是 0 改动。
5. **`api_pull` 不需要 CAS**：单行主键读，直接 `select payload, updated_at`；行不存在时返回旧代码那份 11 键空文档（`server.py:833`）+ `updated: 0`，API 出参键名仍是 `updated`。
6. **notify 不变**：CAS 成功后照旧 `notify(uid, "sync")` 走内存 SSE 广播。

---

## 五、Realtime 预留（决策点 6 · 本期不实现）

**为什么缓**：当前是**单实例 server.py**，`notify()` 的进程内 fan-out 已经能把变更推给同一进程上的所有 SSE 连接，够用。接 Realtime 只有在「多实例 / 多进程」时才有增量价值。

**预留内容**（`schema.sql` 第 7 节，已注释）：

```sql
alter publication supabase_realtime add table public.sync;
alter table public.sync replica identity full;   -- 需要 old_record 时才必须
```

**Phase 5 桥接设计（仅设计，不实现）**：

```
Supabase Realtime (postgres_changes: UPDATE on public.sync)
        │  payload.new.uid
        ▼
server.py 常驻订阅协程（service_role 连接）
        │  去重：忽略 new.payload_version 等于本实例刚写入的版本（避免自激）
        ▼
notify(uid, "sync")          ← 复用现有函数，零改动
        ▼
/api/sync/stream 的每 uid 队列 → 各客户端 EventSource
```

要点：
- 订阅只关心 `uid` 与 `payload_version`，**不传输 payload 本体**（省带宽，客户端收到信号后走 `pullSync()` 拉全量，与现状一致）。
- 需要自激抑制：本实例自己 CAS 写入产生的事件应被丢弃，判据是「刚写入的 `(uid, payload_version)` 在 5 秒内出现在事件里」。
- 断线重连 + 心跳由 supabase-py 的 realtime client 负责；重连后需要给所有在线 uid 补一次 `notify` 触发全量对齐。
- **前置依赖**：Phase 2/5 必须先修 `workbench.html:2850` 的 `EventSource`（见第九节 R-01），否则 SSE 链路本身就是 401，Realtime 接进来也无处可去。

---

## 六、备份策略（决策点 9）

迁移后 `do_backup()`（`server.py:384`，复制 `wb.db` 文件）语义失效。替换为 **Supabase → JSON 周期导出**。

新增脚本 `supabase/export_backup.py`（Phase 2 落地）：

```python
# 用法：
#   python supabase/export_backup.py                 # 导出到 DATA_DIR/backups/
#   python supabase/export_backup.py --out /path     # 指定目录
#   python supabase/export_backup.py --keep 14       # 保留份数
#
# 输出：backups/wb-YYYYmmdd-HHMMSS.json.gz
# 结构：
# {
#   "schema_version": 1,
#   "exported_at": 1730000000,
#   "source": "supabase://<project-ref>",
#   "profiles": [{"uid","username","auth_email","legacy_uid","created_at"}],   # 不含 token_epoch
#   "sync":     [{"uid","payload","payload_version","updated_at"}]
# }
```

流程：
1. service_role 读 `profiles`（**排除 token_epoch 等安全字段**）+ `sync` 全量；单用户约几十 KB，无需分页（>1000 行时按 `range()` 分页）。
2. `json.dumps(..., ensure_ascii=False, sort_keys=True)` → gzip 落盘，文件权限 `600`。
3. 保留最近 `BACKUP_KEEP`（默认 7）份，旧的删除 —— 与旧 `do_backup` 的清理逻辑一致。
4. server.py 内 `backup_loop()` 改为调用它，周期沿用 `BACKUP_INTERVAL`（默认 6 小时）；同时脚本可独立被 cron / 计划任务调用（便于把备份放到与 server 不同的机器）。
5. `POST /api/admin/backup` 接口保留，改为触发这个导出（管理后台契约不变）。
6. **导出物自带回滚价值**：JSON 里的 `payload` 与 `wb.db` 里的 `sync.payload` 结构完全一致，必要时可反向灌回 SQLite。

保留不动：`backups/` 目录下已有的 `wb-*.db` 旧快照、`wb.db` 本体、`backup.sh`（Phase 9 前不删，作回滚兜底）。

---

## 七、数据迁移大纲（Phase 4，本期只设计）

脚本：`supabase/migrate_sqlite_to_supabase.py`

```
参数：--db wb.db  --dry-run  --password-file <每用户新密码>  --email <username=email,...>

Step 0  前置检查
        · SUPABASE_URL / SERVICE_ROLE_KEY 就绪；schema.sql 已执行
        · sqlite3 打开 wb.db，读出 users / sync / invites 三表全量并打印计数
        · 备份现场：复制一份 wb.db 到 backups/wb-premigrate-<ts>.db

Step 1  逐用户建 Supabase Auth 账号（当前只有 1 个：糊糊）
        auth_email = --email 指定的真实邮箱 or derive_auth_email(username)
        new_password = --password-file 里对应项 or 随机生成后打印一次
        sb.auth.admin.create_user({email, password, email_confirm:True,
                                   user_metadata:{username, legacy_uid}})
        → new_uid (uuid)
        幂等：若邮箱已存在，改为 list_users 查出 uid 复用，不重复建号

Step 2  写 profiles
        insert profiles(uid=new_uid, username=old.username,
                        auth_email, legacy_uid=old.uid,
                        token_epoch=int(time.time()), created_at=int(time.time()))
        （upsert on conflict(uid) do update，保证可重跑）

Step 3  搬 sync
        payload = json.loads(old_sync.payload)     # 结构不做任何转换
        upsert sync(uid=new_uid, payload=payload,
                    payload_version=0, updated_at=old_sync.updated or 0)

Step 4  搬 invites（当前 0 行，仍要跑，保证脚本完备）
        used_by 从旧 32-hex 映射成新 uuid（查 legacy_uid），映射不到则置 NULL
        upsert invites(code, created_by=NULL, created_at=now, used_by, used_at)

Step 5  校验（任一失败即判定迁移失败并打印 diff）
        ① 计数：profiles == users 行数；sync 行数一致；invites 行数一致
        ② 文档等价：对每个 uid，把 Supabase 读回的 payload 与 SQLite 的
           json.loads 结果做「规范化后逐字节比对」
           canon = json.dumps(obj, sort_keys=True, ensure_ascii=False,
                              separators=(",", ":"))
           assert canon(pg_payload) == canon(sqlite_payload)
           （注意：不能直接比原始字符串——jsonb 会重排键序、规范化数字）
        ③ 逐键计数：11 个顶层键中，10 个数组键的 len() 必须两边相等
        ④ 抽样往返：随机抽 3 条记录（跨不同键），比对 id/updatedAt/deviceId
           及正文字段完全一致
        ⑤ 登录冒烟：用新密码走一次 /api/auth/login → /api/sync/pull，
           断言返回的 payload 与 ④ 抽样一致

Step 6  输出迁移报告 migration-report-<ts>.json（计数、校验结果、新密码提示）
```

**单用户带来的简化**：无需批处理/分页/断点续传；整个迁移就是「建 1 个账号 + 搬 1 行 sync（40KB 级）」，`--dry-run` 跑通后正式执行通常 <5 秒。失败时的回滚就是「删掉这个 Auth 用户，继续用旧 server.py + wb.db」。

**必须人工完成的一步**：把 `糊糊` 的新密码交给用户（决策点 3 已同意重置）。建议脚本只打印到 stdout 一次，不落盘。

---

## 八、Phase 映射：本设计使能了什么

| Phase | 内容 | 本设计提供的前置 |
|-------|------|-----------------|
| **Phase 1（本期）** | Supabase 设计 | `schema.sql` + 本文档；**不碰任何运行中代码** |
| **Phase 2** | server.py 存储层切换 | §2.5 JWT 签发/校验、§4.2 CAS 完整代码骨架、§3.3 字段映射表、§2.8 环境变量清单；同时修 `workbench.html:2850`（B1 豁免） |
| **Phase 3** | 账号系统迁移 | §2.1 Auth 项目配置、§2.2 username↔email 映射、§2.3/2.4 注册登录流、§2.6 撤销语义、§2.7 profiles 置备 |
| **Phase 4** | 数据迁移 | §7 迁移脚本大纲（含 5 项校验）、§3.3 映射表 |
| **Phase 5** | 同步升级 | §5 Realtime 预留（publication 语句 + 桥接设计 + 自激抑制）；SSE 修复依赖 Phase 2 |
| **Phase 6** | Windows 客户端 | 客户端只改指向云端 server.py；本设计保证 API 契约（token/pull/push 出入参）完全不变 → app.py 只需去掉本地 server 拉起 |
| **Phase 7** | Android 客户端 | 同上，仅填 `BACKEND_URL`；因 token 仍是 30 天长效，Android 侧无刷新逻辑要加 |
| **Phase 8/9** | 测试 / 上线 | §6 JSON 导出提供切换前后的数据快照对比基准；旧 `wb.db` 保留即回滚路径 |

---

## 九、风险与检查清单

| # | 风险 | 影响 | 缓解 |
|---|------|------|------|
| **R-01** | `workbench.html:2850` 的 `EventSource` 带不了 Bearer → `/api/sync/stream` 恒 401 | 实时同步**现在就是坏的**，迁移后依然坏 | 决策点 2 已豁免：Phase 2/5 改这 1 行（改成 fetch + ReadableStream 手写 SSE，或 server.py 接受 `?token=` query 鉴权）。**本期不动** |
| **R-02** | **RLS 静默空集** —— 开了 RLS 但用 anon key 查询，PostgREST 返回 `[]` 而非报错 | 会被误判成「用户没数据」，然后被 CAS 逻辑当作「行不存在」去 insert，覆盖真实数据 | ① server.py **必须**用 service_role；② 启动时做自检：`select count(*) from profiles` 若为 0 但环境标记为已迁移，直接 fail-fast 拒绝启动；③ CAS 建行用 insert（撞主键即失败）而非 upsert，杜绝覆盖 |
| **R-03** | CAS 重试风暴 | 高频 push 下互相顶掉，最坏 5 次全冲突返回 409 | ① 保留进程内 `sync_lock` 做一级串行；② 指数退避 + 抖动；③ 前端 800ms 防抖本就限流；④ 409 对前端无害（不更新 `wb_sync_at`，下轮自动重试） |
| **R-04** | **Supabase Free 档 7 天无活动自动暂停** | 项目挂起 → 全站不可用 | ① server.py 起 keepalive 定时器（每 12h 做一次 `select 1`-级轻查询）；② §6 的周期 JSON 导出天然也是活动；③ 保留旧 `wb.db` 本地兜底，server.py 支持 `STORAGE_BACKEND=sqlite` 环境变量一键回退；④ 长期建议升 Pro |
| **R-05** | 复用 `SUPABASE_JWT_SECRET` 自签 token → 可能被 Supabase 组件当作合法凭证 | 越权读写整库 | 用独立 `WORKBENCH_JWT_SECRET`；固定 `iss/aud`；**永不签发 `role` claim**；显式 `algorithms=["HS256"]` |
| **R-06** | 旧 token 全部失效（PBKDF2 token 表被弃用） | 所有已登录设备被登出一次 | 决策点 3 已接受（本就要重置密码）。切换当天通知用户在 Win/Android 各重登一次 |
| **R-07** | push 从本地 SQLite（<1ms）变成 2 次网络 RTT（读版本 + CAS 写） | 单次 push 从 ~1ms 变 ~100–300ms | 前端是异步防抖 push，用户无感；若后续变慢可考虑把「读版本」结果在进程内缓存（需谨慎，会削弱 CAS） |
| **R-08** | Supabase Auth 对 `.invalid` 合成邮箱的接受度 | 建号被拒 | Phase 3 第一步先用 1 个测试合成邮箱验证 `admin.create_user` 通过；不通过则退回「要求真实邮箱」（单用户，代价为零） |
| **R-09** | 整文档写放大：每次 push 重写全部 payload | 数据长大后写入变慢 | 当前 `wb.db` 仅 40KB，可忽略；超过 ~5MB 时再考虑按顶层键拆行（本期明确不拆） |
| **R-10** | GoTrue 登录接口速率限制 | 频繁登录被 429 | token 30 天长效，登录极稀疏；server.py 侧已有 `auth_limiter`（10min/30 次/IP）先兜一层 |

### Phase 1 交付自检

- [x] 未修改 `server.py` / `workbench.html` / `index.html` / `app.py` / Android 任何文件
- [x] 新文件全部位于 `E:\project\workbench\supabase\`
- [x] `schema.sql` 幂等、可直接在 Supabase SQL Editor 执行
- [x] `merge_records` 语义 1:1 保留（含 settings 假值不覆盖）
- [x] `updated_at` 为 bigint Unix 秒，API 出参仍叫 `updated`
- [x] 无 PL/pgSQL、无 DB 函数、无 psycopg
- [x] Realtime 仅预留（publication 语句处于注释状态）
- [x] 未创建 Supabase 项目、未迁移数据、旧架构完整保留

---

## 十、附录：API 契约不变性对照

| 接口 | 入参 | 出参 | 迁移后变化 |
|------|------|------|-----------|
| `POST /api/auth/signup` | `{username,password,invite?}` | `{token,username}` | 无（token 由 hex 变 JWT，前端无感） |
| `POST /api/auth/login` | `{username,password}` | `{token,username}` | 无 |
| `POST /api/auth/refresh` | Bearer | `{token,username}` | 无 |
| `POST /api/auth/logout` | Bearer | `{ok:true}` | 无 |
| `GET  /api/sync/pull` | Bearer | `{payload,updated}` | 无 |
| `POST /api/sync/push` | Bearer + `{payload}` | `{ok:true,updated}` | 新增 409 冲突分支（前端已能容忍） |
| `GET  /api/sync/stream` | Bearer | SSE | **现存缺陷**，Phase 2/5 修（R-01） |
| `GET  /api/config` | — | `{...}` | 移除 `qq_login` / `wechat_login` 两个字段（决策点 5） |
| `/api/admin/*` | X-Admin-Token | 同旧 | `stats.db_size_bytes` 语义改为「导出 JSON 大小」或置 0 |
| `/api/auth/qq/*`、`/api/auth/wechat/*` | — | — | **整体删除**（决策点 5） |

---

*本文档为 Phase 1 只读设计产物。任何代码改动须待 Phase 2 启动后进行。*
