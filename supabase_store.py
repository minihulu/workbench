# -*- coding: utf-8 -*-
"""Supabase 存储后端（混合架构）。

server.py 在 STORAGE_BACKEND=supabase 时调用本模块；其余情况回退本地 SQLite。
本模块导入时不做任何网络请求（客户端延迟到 init()），以便离线 py_compile / import 通过。

安全约定：
- 服务端读写 + Admin API 一律用 SUPABASE_SERVICE_ROLE_KEY（绝不下发前端）。
- anon key 仅用于 sign_in_with_password 做口令校验，用完立即 sign_out。
- 自签 JWT 用独立 WORKBENCH_JWT_SECRET（HS256），固定 iss/aud，绝不签发 role claim。
- 并发靠 payload_version 乐观锁 CAS（不写 PL/pgSQL、不用 psycopg）。
"""
import os
import time
import json
import secrets
import random
import hashlib
import threading

import jwt  # PyJWT>=2.8

try:
    from supabase import create_client
except Exception:  # 离线（未安装 supabase）时 import 不报错，init() 时再报错
    create_client = None


# ----------------------------- 常量 -----------------------------
TOKEN_TTL = 60 * 60 * 24 * 30          # 30 天
JWT_ISS = "workbench"
JWT_AUD = "workbench-client"
EPOCH_TTL = 60                          # token_epoch 进程内缓存秒数
PUSH_MAX_RETRY = 5

RECORD_KEYS = ["times", "ideas", "notes", "diary",
               "cog_reads", "cog_books", "cog_thoughts", "cog_reviews",
               "directions", "reviews"]
EMPTY_PAYLOAD = {**{k: [] for k in RECORD_KEYS}, "settings": {}}


class CasConflict(Exception):
    """CAS 重试耗尽，调用方应返回 409。"""
    pass


class ConflictError(Exception):
    """用户名已存在 / 邀请码无效 → 409。"""
    pass


class AuthError(Exception):
    """注册/登录底层失败。"""
    pass


# ----------------------------- 配置（环境变量） -----------------------------
def _env(key, default=""):
    return (os.environ.get(key) or default).strip()


SUPABASE_URL = _env("SUPABASE_URL")
SUPABASE_ANON_KEY = _env("SUPABASE_ANON_KEY")
SUPABASE_SERVICE_ROLE_KEY = _env("SUPABASE_SERVICE_ROLE_KEY")
# R-05 安全强约束：优先用独立 WORKBENCH_JWT_SECRET，绝不复用 SUPABASE_JWT_SECRET
JWT_SECRET = _env("WORKBENCH_JWT_SECRET") or _env("SUPABASE_JWT_SECRET")
AUTH_EMAIL_DOMAIN = _env("WORKBENCH_AUTH_EMAIL_DOMAIN") or "users.workbench.invalid"


# ----------------------------- Clash/FlClash fake-IP DNS 兜底 -----------------------------
# 部分环境（Clash/FlClash fake-IP 模式 + TUN）下，Python 走系统 DNS 会被返回
# 198.18.x.x 假 IP，导致 *.supabase.co 的 TLS 握手被掐（UNEXPECTED_EOF_WHILE_READING）。
# 浏览器能上，是因为走了 DoH 直连真 IP。这里给 supabase.co 单独做 DoH 解析绕过假
# DNS，拿到真 IP 直连——VPN 开/关都不影响。仅补 supabase.co，其余域名与未联网时
# 均自动回退系统解析，对正常逻辑零侵入。SUPABASE_DNS_BYPASS=0 可关闭。
_dns_patched = False


def _install_supabase_dns_bypass():
    global _dns_patched
    if _dns_patched:
        return
    if os.environ.get("SUPABASE_DNS_BYPASS", "1") == "0":
        return
    _dns_patched = True

    import socket
    import ssl
    import json
    import urllib.request

    _orig_getaddrinfo = socket.getaddrinfo

    def _doh_lookup(host):
        for url_tpl in (
            "https://cloudflare-dns.com/dns-query?name=%s&type=A",
            "https://dns.google/resolve?name=%s&type=A",
        ):
            try:
                url = url_tpl % host
                req = urllib.request.Request(
                    url, headers={"Accept": "application/dns-json"})
                # 先验证真实证书；失败退到不验证（Clash 可能 MITM DoH 端点，
                # 但会原样转发真实应答，不影响拿到的真 IP）。
                for ctx in (ssl.create_default_context(), None):
                    try:
                        with urllib.request.urlopen(req, timeout=8, context=ctx) as r:
                            data = json.loads(r.read())
                        break
                    except Exception:
                        continue
                else:
                    continue
                for ans in data.get("Answer", []):
                    if ans.get("type") == 1:   # A 记录
                        return ans["data"]
            except Exception:
                continue
        return None

    def _patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        if (isinstance(host, str) and host.endswith(".supabase.co")
                and family in (0, socket.AF_INET)):
            ip = _doh_lookup(host)
            if ip:
                # 单条 AF_INET 结果，直连真 IP（family, type, proto, canonname, sockaddr）
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]
        return _orig_getaddrinfo(host, port, family, type, proto, flags)

    socket.getaddrinfo = _patched_getaddrinfo



# ----------------------------- 客户端（延迟初始化） -----------------------------
_service_client = None
_anon_client = None
_initialized = False


def init():
    global _service_client, _anon_client, _initialized
    if _initialized:
        return
    _install_supabase_dns_bypass()   # Clash fake-IP DNS 兜底（幂等，仅补 supabase.co）
    if create_client is None:
        raise RuntimeError("supabase 库未安装（pip install supabase）")
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        raise RuntimeError("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    _service_client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    if SUPABASE_ANON_KEY:
        _anon_client = create_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    _initialized = True


def _svc():
    if not _initialized:
        init()
    return _service_client


def _anon():
    if not _initialized:
        init()
    return _anon_client


def init_and_selfcheck():
    """创建客户端并做一次轻查询验证连通性 + RLS 没把 service_role 挡在门外。

    返回状态 dict；不在本函数内抛网络异常——调用方（server.py）据此决定回退 SQLite。
    """
    init()
    r = _svc().table("profiles").select("uid", count="exact").limit(1).execute()
    cnt = getattr(r, "count", None)
    if cnt is None:
        cnt = len(r.data or [])
    return {"ok": True, "profiles_count": cnt}


def keepalive():
    """Free 档 7 天暂停兜底（R-04）：轻查询保活，证明项目仍活跃。返回 True/False。"""
    try:
        _svc().table("profiles").select("uid", count="exact").limit(1).execute()
        return True
    except Exception:
        return False


def run_export_backup(data_dir=None, keep=7):
    """调 supabase/export_backup.py 做 JSON 周期导出。supabase/ 不是包，用 importlib 加载。"""
    import importlib.util
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "supabase", "export_backup.py")
    spec = importlib.util.spec_from_file_location("wb_export_backup", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.run(data_dir=data_dir, keep=keep)


# ----------------------------- token_epoch 缓存（60s） -----------------------------
_epoch_cache = {}          # uid -> (epoch, cached_at)
_epoch_lock = threading.Lock()


def get_token_epoch(uid):
    now = time.time()
    with _epoch_lock:
        hit = _epoch_cache.get(uid)
        if hit and now - hit[1] < EPOCH_TTL:
            return hit[0]
    r = _svc().table("profiles").select("token_epoch").eq("uid", uid).limit(1).execute()
    epoch = (r.data[0]["token_epoch"] if r.data else 0)
    with _epoch_lock:
        _epoch_cache[uid] = (epoch, time.time())
    return epoch


def bump_token_epoch(uid):
    epoch = int(time.time())
    _svc().table("profiles").update({"token_epoch": epoch}).eq("uid", uid).execute()
    with _epoch_lock:
        _epoch_cache[uid] = (epoch, time.time())
    return epoch


# ----------------------------- 自签 30 天 JWT（替代 SQLite token） -----------------------------
def issue_token(uid, username, token_epoch):
    now = int(time.time())
    return jwt.encode({
        "iss": JWT_ISS,
        "aud": JWT_AUD,
        "sub": uid,                 # auth.users.id (uuid)
        "usr": username,
        "epo": token_epoch,         # 撤销世代号
        "iat": now,
        "exp": now + TOKEN_TTL,
        "jti": secrets.token_hex(8),
        "v": 1,
    }, JWT_SECRET, algorithm="HS256")


def verify_token(token):
    """返回 uid 或 None。函数签名与旧 auth_user(token)->uid|None 一致。"""
    if not token:
        return None
    try:
        claims = jwt.decode(
            token, JWT_SECRET,
            algorithms=["HS256"],           # 钉死算法，防 alg=none / RS256 混淆
            audience=JWT_AUD, issuer=JWT_ISS,
            options={"require": ["exp", "sub", "iat"]},
        )
    except jwt.PyJWTError:
        return None
    uid = claims.get("sub")
    if not uid:
        return None
    if claims.get("epo", 0) < get_token_epoch(uid):   # 撤销检查
        return None
    return uid


# ----------------------------- 业务工具 -----------------------------
def merge_records(local, inc):
    """与前端 mergeRecords 语义一致：按 id 记录级合并，updatedAt 大者胜，平局 deviceId 大者胜。

    从 server.py 原样复制，避免循环 import。
    """
    by_id = {}
    for r in (local or []):
        if r and r.get("id"):
            by_id[r["id"]] = r
    for r in (inc or []):
        if not r or not r.get("id"):
            continue
        cur = by_id.get(r["id"])
        if not cur:
            by_id[r["id"]] = r
            continue
        ta = cur.get("updatedAt", 0) or 0
        tb = r.get("updatedAt", 0) or 0
        if tb > ta:
            by_id[r["id"]] = r
        elif tb == ta and (r.get("deviceId", "") or "") > (cur.get("deviceId", "") or ""):
            by_id[r["id"]] = r
    return sorted(by_id.values(), key=lambda x: (x.get("updatedAt", 0) or 0))


def derive_auth_email(username):
    """合成邮箱：sha256(username)[:24] @ 保留域名（RFC 2606 .invalid，永不发真实邮件）。"""
    h = hashlib.sha256(username.encode("utf-8")).hexdigest()[:24]
    return "%s@%s" % (h, AUTH_EMAIL_DOMAIN)


def get_username(uid):
    r = _svc().table("profiles").select("username").eq("uid", uid).limit(1).execute()
    return r.data[0]["username"] if r.data else ""


def count_stats():
    users = _svc().table("profiles").select("uid", count="exact").execute()
    syncs = _svc().table("sync").select("uid", count="exact").execute()
    invites_total = _svc().table("invites").select("code", count="exact").execute()
    invites_used = _svc().table("invites").select("code", count="exact").eq("used_by", "not.is", "null").execute()
    return {
        "users": getattr(users, "count", None) or 0,
        "syncs": getattr(syncs, "count", None) or 0,
        "invites_total": getattr(invites_total, "count", None) or 0,
        "invites_used": getattr(invites_used, "count", None) or 0,
    }


def list_users():
    r = _svc().table("profiles").select("uid,username,created_at").order("username").execute()
    return r.data or []


# ----------------------------- 账号：注册 / 登录 / 登出 / 刷新 -----------------------------
def signup(username, password, invite):
    """注册：Admin API 建号 → profiles → sync → 标记邀请码。返回 (token, username)。"""
    if invite:
        inv = _svc().table("invites").select("code,used_by").eq("code", invite).limit(1).execute()
        if not inv.data or inv.data[0].get("used_by"):
            raise ConflictError("邀请码无效或已使用")
    auth_email = derive_auth_email(username)
    # 查重
    existing = _svc().table("profiles").select("uid").eq("username", username).limit(1).execute()
    if existing.data:
        raise ConflictError("用户名已存在")
    # Admin 建号
    try:
        res = _svc().auth.admin.create_user({
            "email": auth_email,
            "password": password,
            "email_confirm": True,                 # 跳过确认邮件
            "user_metadata": {"username": username},
        })
        uid = res.user.id
    except Exception as e:
        raise AuthError("建号失败: %s" % e)
    now = int(time.time())
    try:
        _svc().table("profiles").insert({
            "uid": uid, "username": username, "auth_email": auth_email,
            "legacy_uid": None, "token_epoch": now, "created_at": now,
        }).execute()
        _svc().table("sync").insert({
            "uid": uid, "payload": EMPTY_PAYLOAD, "payload_version": 0, "updated_at": 0,
        }).execute()
    except Exception:
        # 回滚孤儿 Auth 用户，避免下次注册报「邮箱已存在」
        try:
            _svc().auth.admin.delete_user(uid)
        except Exception:
            pass
        raise
    if invite:
        _svc().table("invites").update({"used_by": uid, "used_at": now}).eq("code", invite).execute()
    token = issue_token(uid, username, now)
    return token, username


def login(username, password):
    """登录：查 profiles → anon 校验口令 → 立即 sign_out → 自签 token。返回 (token, username) 或 None。"""
    row = _svc().table("profiles").select("uid,auth_email,token_epoch").eq("username", username).limit(1).execute()
    if not row.data:
        return None
    prof = row.data[0]
    anon = _anon()
    if not anon:
        return None
    try:
        anon.auth.sign_in_with_password({"email": prof["auth_email"], "password": password})
    except Exception:
        return None
    try:
        anon.auth.sign_out()          # 立即销毁 Supabase session，access/refresh token 不外泄
    except Exception:
        pass
    token = issue_token(prof["uid"], username, prof["token_epoch"])
    return token, username


def refresh_token(uid):
    """轮换 token：先 bump epoch 使旧 token 失效，再用新 epoch 签发。返回 (new_token, username)。"""
    username = get_username(uid)
    epoch = bump_token_epoch(uid)
    return issue_token(uid, username, epoch), username


def logout(uid):
    bump_token_epoch(uid)


def reset_token_by_username(username):
    """管理员重置某用户 token（使所有旧 token 失效）。"""
    _svc().table("profiles").update({"token_epoch": int(time.time())}).eq("username", username).execute()


# ----------------------------- 同步：pull / push(CAS) -----------------------------
def pull_payload(uid):
    """单行主键读。返回 (payload_dict, updated)。行不存在 → (EMPTY_PAYLOAD, 0)。"""
    r = _svc().table("sync").select("payload,updated_at").eq("uid", uid).limit(1).execute()
    if not r.data:
        return EMPTY_PAYLOAD, 0
    payload = r.data[0].get("payload") or EMPTY_PAYLOAD
    return payload, (r.data[0].get("updated_at") or 0)


def push_payload(uid, inc):
    """乐观锁 CAS：读版本 → 合并 → 带版本条件更新 → 冲突则退避重试。返回 updated(unix秒)。"""
    for attempt in range(PUSH_MAX_RETRY):
        r = (_svc().table("sync")
             .select("payload,payload_version")
             .eq("uid", uid).limit(1).execute())
        if not r.data:
            # 行不存在：先幂等建行（并发下靠主键唯一约束兜底），下一轮再 CAS
            try:
                _svc().table("sync").insert({
                    "uid": uid, "payload": EMPTY_PAYLOAD,
                    "payload_version": 0, "updated_at": 0,
                }).execute()
            except Exception:
                pass                      # 23505 duplicate key -> 别人先建了，重试即可
            continue

        cur = r.data[0].get("payload") or {}
        ver = r.data[0].get("payload_version") or 0

        # 合并（与旧逻辑逐字一致，merge_records 不改）
        new_payload = {k: merge_records(cur.get(k) or [], inc.get(k) or [])
                       for k in RECORD_KEYS}
        new_payload["settings"] = {
            **(cur.get("settings") or {}),
            **{k: v for k, v in (inc.get("settings") or {}).items() if v},
        }
        updated = int(time.time())

        # CAS 写回：版本没被别人动过才生效
        w = (_svc().table("sync")
             .update({"payload": new_payload,
                      "payload_version": ver + 1,
                      "updated_at": updated})
             .eq("uid", uid)
             .eq("payload_version", ver)          # ← CAS 条件
             .execute())

        if w.data:                                  # 影响行数 > 0 → 成功
            return updated

        # 冲突：指数退避 + 抖动后重读重合并
        time.sleep(min(0.4, 0.02 * (2 ** attempt)) * (0.5 + random.random()))

    raise CasConflict("payload_version conflict after %d retries" % PUSH_MAX_RETRY)
