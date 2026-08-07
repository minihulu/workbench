#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「我的工作台」后端 —— 零依赖（仅 Python 标准库）

功能：
  1. 托管前端静态文件（index.html / workbench.html ...）
  2. /api/github/search  —— 代理 GitHub 搜索（解决浏览器直连被墙的问题）
  3. /api/auth/*         —— 注册 / 登录 / 刷新 / 退出（PBKDF2 口令哈希 + Bearer Token）
  4. /api/sync/pull|push —— 云端同步（记录级合并，last-write-wins）
  5. /api/sync/stream    —— SSE 实时多端同步
  6. /api/config         —— 公开配置（前端据此决定注册表单是否要邀请码）
  7. /api/admin/*        —— 管理后台（ADMIN_TOKEN 保护：统计/用户/开关注册/重置/备份）

运行（本机）：
  python server.py                 # 默认 http://0.0.0.0:8000
  PORT=9000 python server.py
  GH_TOKEN=ghp_xxx python server.py   # 给 GitHub 代理一个服务端令牌（提升限额到 5000/h）
  GH_PROXY=http://127.0.0.1:7890 python server.py   # 显式指定出网代理（解决 Windows 系统代理 urllib 读不到的问题）
  REGISTER_OPEN=0 python server.py    # 关闭公开注册
  REGISTER_REQUIRE_INVITE=1 INVITE_CODES=wb-aaa,wb-bbb python server.py   # 邀请码注册
  ADMIN_TOKEN=xxxx python server.py   # 开启管理后台

自托管（Docker）：见 docker-compose.yml，一条命令起。

数据：当前目录 wb.db（SQLite，按 uid 隔离，多人共用单库即可）
"""
import os
import re
import sys
import json
import time
import queue
import sqlite3
import secrets
import shutil
import hashlib
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, urlencode
import urllib.request
import urllib.error

# Supabase 存储后端（Phase 2 混合架构）。导入时不建网络客户端，离线也可 import。
# 仅当 STORAGE_BACKEND=supabase 且 main() 初始化成功时，全局 STORE 才会被赋值。
try:
    import supabase_store
except Exception:
    supabase_store = None

# --- 控制台编码兜底 ---
# Windows 控制台默认 GBK，print 里的 ✅/⚠️ 等字符会抛 UnicodeEncodeError，
# 直接把后端进程打崩（尤其被 .exe 以 stdout=DEVNULL 拉起时）。这里强制 UTF-8 + 容错。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _p(*args, **kwargs):
    """永不因编码问题崩溃的 print。"""
    try:
        print(*args, **kwargs)
    except Exception:
        try:
            msg = " ".join(str(a) for a in args)
            sys.stderr.write(msg.encode("ascii", "replace").decode("ascii") + "\n")
        except Exception:
            pass


WORKDIR = os.path.dirname(os.path.abspath(__file__))


# --- 配置文件加载（免去每次命令行 set 环境变量） ---
def _load_env_files():
    """按优先级读取 wb.env 配置文件，写入 os.environ。

    查找顺序（先找到的先生效，后面的不覆盖前面的）：
      1) 环境变量 WB_ENV 指定的文件
      2) 脚本同目录 wb.env
      3) %LOCALAPPDATA%\\workbench\\wb.env（Windows 用户级，exe 场景推荐）
      4) ~/.workbench/wb.env

    规则：真实环境变量永远优先，文件只填补空缺。
    格式：KEY=VALUE，# 开头为注释，值两侧引号会被剥掉。
    """
    paths = []
    if os.environ.get("WB_ENV"):
        paths.append(os.environ["WB_ENV"])
    paths.append(os.path.join(WORKDIR, "wb.env"))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        paths.append(os.path.join(local, "workbench", "wb.env"))
    paths.append(os.path.join(os.path.expanduser("~"), ".workbench", "wb.env"))
    paths.append(os.path.join(WORKDIR, ".env"))   # Supabase 凭证落盘处（最低优先级，不覆盖上面）

    loaded = []
    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8-sig") as f:
                content = f.read()
        except Exception:
            continue
        n = 0
        for raw in content.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if not key or key in os.environ:      # 真实环境变量优先，不覆盖
                continue
            os.environ[key] = val
            n += 1
        if n:
            loaded.append("%s(%d项)" % (path, n))
    return loaded


ENV_FILES_LOADED = _load_env_files()

DATA_DIR = os.environ.get("DATA_DIR", WORKDIR)   # Docker 下挂卷到 /data，设 DATA_DIR=/data
DB = os.path.join(DATA_DIR, "wb.db")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
PORT = int(os.environ.get("PORT", "8000"))
GH_TOKEN = os.environ.get("GH_TOKEN", "").strip()
GH_PROXY = os.environ.get("GH_PROXY", "").strip()
REGISTER_OPEN = os.environ.get("REGISTER_OPEN", "1") == "1"
REGISTER_REQUIRE_INVITE = os.environ.get("REGISTER_REQUIRE_INVITE", "0") == "1"
INVITE_CODES = [c.strip() for c in os.environ.get("INVITE_CODES", "").split(",") if c.strip()]
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "").strip()
BACKUP_INTERVAL = int(os.environ.get("BACKUP_INTERVAL", "21600"))   # 默认 6 小时备份一次

# ----- 第三方登录（QQ / 微信） -----
QQ_APP_ID = os.environ.get("QQ_APP_ID", "").strip()
QQ_APP_SECRET = os.environ.get("QQ_APP_SECRET", "").strip()
WECHAT_APP_ID = os.environ.get("WECHAT_APP_ID", "").strip()
WECHAT_APP_SECRET = os.environ.get("WECHAT_APP_SECRET", "").strip()
# OAuth 回调地址：前端轮询用。格式 http://<host>:<port>/api/auth/{provider}/callback
# 实际回调由服务端代理，不需要公网域名——本地开发也行。
_oauth_sessions = {}   # state -> {provider, created_at, result: {ok, token, username} | None}
_oauth_lock = threading.Lock()
BACKUP_KEEP = int(os.environ.get("BACKUP_KEEP", "7"))
TOKEN_TTL = 60 * 60 * 24 * 30          # Token 有效期 30 天
PBKDF2_ITERS = 200_000
VERSION = "1.2.0"

# ----- Supabase 混合存储引导 -----
# 默认：若环境变量里给了 SUPABASE_URL + SERVICE_ROLE_KEY 则启用 Supabase；否则回退本地 SQLite。
# 显式 STORAGE_BACKEND=sqlite 可强制回退（迁移期回滚兜底）。
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_SVC = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND",
    "supabase" if (SUPABASE_URL and SUPABASE_SVC) else "sqlite").strip().lower()
STORE = None   # supabase_store 模块（STORAGE_BACKEND=supabase 且初始化成功时设置）

# ----- 语义重排 LLM（可选；留空即关闭，搜索自动降级为关键词模式；零第三方依赖） -----
# 前端可经 X-LLM-Token 自带 Key（BYOK）；未配则前端不发重排请求，P0 关键词搜索不受影响。
LLM_API_KEY   = os.environ.get("LLM_API_KEY", "").strip()
LLM_BASE_URL  = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1").strip().rstrip("/")
LLM_MODEL     = os.environ.get("LLM_MODEL", "deepseek-chat").strip()
LLM_TIMEOUT   = float(os.environ.get("LLM_TIMEOUT", "10") or 10)   # 前端 8s，务必让服务端 >= 前端
LLM_PROXY     = os.environ.get("LLM_PROXY", "").strip()
# SSRF 白名单：X-LLM-Base 仅当命中白名单才生效，否则忽略（绝不直接把请求头当 URL 用）
LLM_ALLOWED_BASES = [b.strip().rstrip("/") for b in os.environ.get(
    "LLM_ALLOWED_BASES",
    "https://api.deepseek.com/v1,"
    "https://api.openai.com/v1,"
    "https://dashscope.aliyuncs.com/compatible-mode/v1,"
    "https://api.moonshot.cn/v1,"
    "https://api.siliconflow.cn/v1").split(",") if b.strip()]

db_lock = threading.Lock()
subscribers = {}                       # uid -> [queue.Queue, ...]  （SSE 订阅者）
sub_lock = threading.Lock()

# ----------------------------- 出网代理（GitHub 用） -----------------------------
# 优先级：GH_PROXY 环境变量 > HTTPS_PROXY/HTTP_PROXY 环境变量 > Windows 系统代理(注册表)
def _parse_proxy_string(s):
    """把各种形式的代理串解析成 {'http':..,'https':..}。"""
    if not s:
        return None
    s = s.strip()
    if s.startswith("http://") or s.startswith("https://"):
        return {"http": s, "https": s}
    # 形如 "127.0.0.1:7890" 或 "host:port"
    if re.match(r"^[\w.\-]+:\d+$", s):
        return {"http": "http://" + s, "https": "http://" + s}
    # 形如 "http=127.0.0.1:7890;https=127.0.0.1:7890;ftp=..."
    if "=" in s:
        out = {}
        for part in s.split(";"):
            if "=" in part:
                proto, addr = part.split("=", 1)
                proto = proto.strip().lower()
                addr = addr.strip()
                if not addr:
                    continue
                if not (addr.startswith("http://") or addr.startswith("https://")):
                    addr = "http://" + addr
                if proto in ("http", "https"):
                    out[proto] = addr
        if out:
            out.setdefault("https", out.get("http", ""))
            out.setdefault("http", out.get("https", ""))
            return out or None
    return None


def _detect_windows_proxy():
    """Windows 上 Clash 等通常只写进注册表(系统代理)，urllib 默认读不到，这里显式读取。"""
    try:
        import winreg
    except Exception:
        return None
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        try:
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
        except Exception:
            enabled = 0
        if not enabled:
            return None
        try:
            server, _ = winreg.QueryValueEx(key, "ProxyServer")
        except Exception:
            return None
        return _parse_proxy_string(server)
    except Exception:
        return None


def _probe_common_ports():
    """兜底：当无任何显式代理配置时，探测本地常见代理端口（Clash/v2ray 等）。
    命中能连通 GitHub 的端口即用。仅在无代理时触发，端口少、超时短。"""
    test = "https://api.github.com/healthz"
    for port in (7890, 7891, 1080, 10808, 10809):
        proxy = "http://127.0.0.1:%d" % port
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler(
                {"http": proxy, "https": proxy}))
            with opener.open(test, timeout=1.2) as r:
                if r.status == 200:
                    return {"http": proxy, "https": proxy}
        except Exception:
            continue
    return None


def _resolve_gh_proxy():
    p = None
    if GH_PROXY:
        p = _parse_proxy_string(GH_PROXY)
    if not p:
        env = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
        p = _parse_proxy_string(env)
    if not p:
        p = _detect_windows_proxy()
    if not p:
        # 仅当直连 GitHub 失败时，才探测本地端口（避免无代理环境下无谓等待）
        try:
            urllib.request.urlopen("https://api.github.com/healthz", timeout=1.2)
            return None  # 直连已通（如 TUN 模式），无需代理
        except Exception:
            p = _probe_common_ports()
    return p


GH_PROXY_DICT = _resolve_gh_proxy()


def build_gh_opener():
    if GH_PROXY_DICT:
        return urllib.request.build_opener(urllib.request.ProxyHandler(GH_PROXY_DICT))
    return urllib.request.build_opener()


GH_OPENER = build_gh_opener()

# LLM 独立 opener：不复用 GH_OPENER（GitHub 走代理、DeepSeek 国内直连；混用会把国内端点也塞进代理导致超时）
# LLM_PROXY 显式配置才走代理，否则 ProxyHandler({}) 强制直连（不继承系统/环境代理）
LLM_OPENER = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": LLM_PROXY, "https": LLM_PROXY} if LLM_PROXY else {})
)


# ----------------------------- 限流 -----------------------------
class RateLimiter:
    """极简滑动窗口限流（内存级，够 MVP 用）。"""
    def __init__(self, max_req, window):
        self.max = max_req
        self.window = window
        self.hits = {}
        self.lock = threading.Lock()

    def allow(self, key):
        now = time.time()
        with self.lock:
            lst = self.hits.get(key, [])
            lst = [t for t in lst if now - t < self.window]
            if len(lst) >= self.max:
                self.hits[key] = lst
                return False, int(self.window - (now - lst[0]))
            lst.append(now)
            self.hits[key] = lst
            return True, 0


auth_limiter = RateLimiter(30, 600)        # 每个 IP：10 分钟内最多 30 次注册/登录尝试
github_limiter = RateLimiter(90, 60)       # 每个 IP：每分钟最多 90 次 GitHub 搜索
rerank_limiter = RateLimiter(10, 60)       # 每 IP 10 次/分钟；LLM 有真实成本，不共用 github_limiter
_MODEL_RE = re.compile(r"^[A-Za-z0-9._:/-]{1,64}$")


# ----------------------------- 数据库 -----------------------------
def db():
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with db_lock:
        conn = db()
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users(
            uid       TEXT PRIMARY KEY,
            username  TEXT UNIQUE NOT NULL,
            salt      TEXT NOT NULL,
            verifier  TEXT NOT NULL,
            token     TEXT,
            token_exp INTEGER
        );
        CREATE TABLE IF NOT EXISTS sync(
            uid      TEXT PRIMARY KEY,
            payload  TEXT,
            updated  INTEGER
        );
        CREATE TABLE IF NOT EXISTS invites(
            code     TEXT PRIMARY KEY,
            used_by  TEXT,
            used_at  INTEGER
        );
        """)
        # 把环境变量里的初始邀请码灌进库（已存在则忽略）
        for c in INVITE_CODES:
            conn.execute("INSERT OR IGNORE INTO invites(code, used_by, used_at) VALUES(?, NULL, NULL)", (c,))
        conn.commit()
        conn.close()


# ----------------------------- 工具函数 -----------------------------
def pw_hash(password, salt):
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PBKDF2_ITERS
    ).hex()


def auth_user(token):
    # Supabase 模式：用自签 JWT 校验（含 token_epoch 撤销检查）
    if STORE:
        return STORE.verify_token(token)
    # ---- 原 SQLite 分支（兜底） ----
    if not token:
        return None
    conn = db()
    row = conn.execute(
        "SELECT uid, token_exp FROM users WHERE token=?", (token,)
    ).fetchone()
    conn.close()
    if not row:
        return None
    if row["token_exp"] and row["token_exp"] < int(time.time()):
        return None
    return row["uid"]


def bearer(req):
    h = req.headers.get("Authorization", "")
    return h[7:].strip() if h.startswith("Bearer ") else ""


def client_ip(req):
    xff = req.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return req.client_address[0]


def merge_records(local, inc):
    """与前端 mergeRecords 语义一致：按 id 记录级合并，updatedAt 大者胜，平局 deviceId 大者胜。"""
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


def notify(uid, msg="sync"):
    with sub_lock:
        for q in subscribers.get(uid, []):
            try:
                q.put_nowait(msg)
            except Exception:
                pass


# ----------------------------- 自动备份 -----------------------------
def do_backup():
    try:
        # Supabase 后端：改为 JSON 周期导出（DESIGN.md §6），不再复制 SQLite 文件
        if STORE:
            res = STORE.run_export_backup(DATA_DIR, BACKUP_KEEP)
            _p("✅ Supabase 备份完成:", res.get("file") if isinstance(res, dict) else res)
            return
        if not os.path.exists(DB):
            return
        os.makedirs(BACKUP_DIR, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        dst = os.path.join(BACKUP_DIR, "wb-%s.db" % ts)
        # 一致性快照：连到同一个库做在线备份
        conn = sqlite3.connect(DB, timeout=30)
        with open(dst, "wb") as f:
            for chunk in conn.iterdump():
                pass
        conn.close()
        # 直接文件复制更简单稳妥
        shutil.copyfile(DB, dst)
        # 清理旧备份，保留最近 BACKUP_KEEP 份
        files = sorted(
            (f for f in os.listdir(BACKUP_DIR) if f.startswith("wb-") and f.endswith(".db")),
            reverse=True,
        )
        for old in files[BACKUP_KEEP:]:
            try:
                os.remove(os.path.join(BACKUP_DIR, old))
            except Exception:
                pass
    except Exception as e:
        _p("⚠️ 备份失败:", e)


def backup_loop():
    while True:
        time.sleep(BACKUP_INTERVAL)
        do_backup()


# ----------------------------- LLM 语义重排（urllib 手写，零第三方包） -----------------------------
def llm_chat(base, key, model, messages, timeout):
    """OpenAI 兼容 Chat Completions，标准库实现。返回 content 字符串，异常向上抛。"""
    payload = json.dumps({"model": model, "messages": messages,
                          "temperature": 0, "max_tokens": 1500, "stream": False},
                         ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + "/chat/completions", data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + key)
    req.add_header("User-Agent", "workbench")
    with LLM_OPENER.open(req, timeout=timeout) as r:
        j = json.loads(r.read().decode("utf-8", "replace"))
    return (j.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


def extract_json_array(text):
    """LLM 常带 ```json 代码块 / 前后废话：截首个 [ 到末个 ] 再 loads。"""
    i, k = text.find("["), text.rfind("]")
    if i < 0 or k <= i:
        raise ValueError("no json array")
    return json.loads(text[i:k + 1])


# ----------------------------- HTTP 处理器 -----------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send_json(self, status, obj, extra_headers=None):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # ----- 静态文件 -----
    MIME = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".svg": "image/svg+xml",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }

    def serve_static(self, path):
        # 单一真相：workbench.html 是唯一维护的前端；index.html 只是历史副本。
        # 把 / 与 /index.html 一律指向 workbench.html，避免两份文件不同步导致「改了没生效」。
        if path in ("", "/", "/index.html"):
            if os.path.isfile(os.path.join(WORKDIR, "workbench.html")):
                path = "/workbench.html"
            else:
                path = "/index.html"
        rel = path.lstrip("/")
        full = os.path.normpath(os.path.join(WORKDIR, rel))
        if not full.startswith(WORKDIR) or not os.path.isfile(full):
            self.send_error(404, "Not Found")
            return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", self.MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        # 彻底禁缓存：WebView2/浏览器缓存旧版前端 JS 会导致「改了代码却没生效」
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(data)

    # ----- GitHub 搜索代理 -----
    def github_search(self, params, req_headers):
        if not GH_PROXY_DICT and not GH_TOKEN:
            # 没有代理也没有服务端 token：直连几乎必被墙，提前给清晰提示
            self._send_json(502, {
                "error": "github_proxy_unavailable",
                "detail": "服务端未配置出网代理(GH_PROXY)且无 GH_TOKEN，浏览器直连 GitHub 通常被墙。"
                          "部署时设置 GH_PROXY=http://<代理地址> 或 GH_TOKEN=ghp_xxx 后再试。",
            })
            return
        base = "https://api.github.com/search/repositories"
        url = base + "?" + urlencode(params)
        req = urllib.request.Request(
            url, headers={"Accept": "application/vnd.github+json", "User-Agent": "workbench"}
        )
        tok = req_headers.get("X-GH-Token") or GH_TOKEN
        if tok:
            req.add_header("Authorization", "Bearer " + tok)
        try:
            resp = GH_OPENER.open(req, timeout=15)
            body = resp.read()
            status = resp.getcode()
            rl = {k: v for k, v in resp.headers.items()
                  if k.lower().startswith("x-ratelimit")}
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            for k, v in rl.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            rl = {k: v for k, v in e.headers.items()
                  if k.lower().startswith("x-ratelimit")}
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            for k, v in rl.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self._send_json(502, {"error": "github_proxy_failed", "detail": str(e)})

    # ----- SSE 实时同步 -----
    def sync_stream(self, uid):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = queue.Queue()
        with sub_lock:
            subscribers.setdefault(uid, []).append(q)
        try:
            self.wfile.write(b": ok\n\n")
            self.wfile.flush()
            while True:
                msg = q.get()
                try:
                    self.wfile.write(("data: " + msg + "\n\n").encode("utf-8"))
                    self.wfile.flush()
                except Exception:
                    break
        finally:
            with sub_lock:
                if uid in subscribers and q in subscribers[uid]:
                    subscribers[uid].remove(q)

    # ----- 业务接口 -----
    def api_config(self):
        return self._send_json(200, {
            "app": "workbench",
            "version": VERSION,
            "pid": os.getpid(),
            "workdir": WORKDIR,
            "storage_backend": STORAGE_BACKEND,
            "store": "supabase" if STORE else "sqlite",
            "register_open": REGISTER_OPEN,
            "register_require_invite": REGISTER_REQUIRE_INVITE,
            "github_proxy": bool(GH_TOKEN or GH_PROXY_DICT),
            "github_proxy_detail": (GH_PROXY_DICT or ("GH_TOKEN" if GH_TOKEN else None)),
            "llm_rerank": bool(LLM_API_KEY),   # 服务端是否已配 key（默认 False）
            "llm_rerank_byok": True,           # 是否接受前端自带 key（X-LLM-Token）
            "llm_model": LLM_MODEL if LLM_API_KEY else "",
            "qq_login": bool(QQ_APP_ID and QQ_APP_SECRET),
            "wechat_login": bool(WECHAT_APP_ID and WECHAT_APP_SECRET),
        })

    def _sanitize_candidates(self, lst):
        """候选净化：只保留元数据字段；desc≤200 / topics≤6 / N≤25；绝不传 README 正文。"""
        out = []
        for it in (lst or [])[:25]:
            if not isinstance(it, dict):
                continue
            fn = it.get("full_name")
            if not isinstance(fn, str) or not fn or len(fn) > 120:
                continue
            desc = str(it.get("description") or "")[:200]
            topics = [str(t) for t in (it.get("topics") or []) if isinstance(t, str)][:6]
            cand = {"full_name": fn, "description": desc, "topics": topics}
            if isinstance(it.get("language"), str) and it["language"]:
                cand["language"] = it["language"]
            if isinstance(it.get("stars"), (int, float)):
                cand["stars"] = int(it["stars"])
            if isinstance(it.get("pushed_at"), str) and it["pushed_at"]:
                cand["pushed_at"] = it["pushed_at"][:10]
            out.append(cand)
        return out

    def api_search_rerank(self, body):
        """LLM 语义重排：任何路径都返回 200；失败一律 {ok:false, fallback:true}（前端静默降级）。"""
        ok, retry = rerank_limiter.allow("llm:" + client_ip(self))
        if not ok:
            return self._send_json(200, {"ok": False, "fallback": True, "reason": "rate_limited",
                                         "retry": retry})
        query = (body.get("query") or "").strip()
        cands_in = body.get("candidates")
        if not query or not isinstance(cands_in, list) or not cands_in:
            return self._send_json(200, {"ok": False, "fallback": True, "reason": "bad_request"})
        # key 来源：X-LLM-Token（前端 BYOK）> 服务端 LLM_API_KEY
        key = (self.headers.get("X-LLM-Token") or "").strip() or LLM_API_KEY
        if not key:
            return self._send_json(200, {"ok": False, "fallback": True, "reason": "llm_not_configured"})
        # base 白名单（防 SSRF）：X-LLM-Base 仅当命中白名单才生效，否则忽略
        base = LLM_BASE_URL
        want = (self.headers.get("X-LLM-Base") or "").strip().rstrip("/")
        if want and want in LLM_ALLOWED_BASES:
            base = want
        # model 正则消毒
        model = LLM_MODEL
        want_m = (self.headers.get("X-LLM-Model") or "").strip()
        if want_m and _MODEL_RE.match(want_m):
            model = want_m
        cands = self._sanitize_candidates(cands_in)
        if not cands:
            return self._send_json(200, {"ok": False, "fallback": True, "reason": "bad_request"})
        t0 = time.time()
        system = ("你是开源仓库检索的相关性评审。只依据给出的候选元数据判断「仓库的实际功能是否满足用户需求」。"
                  "严禁推荐候选清单之外的任何仓库；严禁编造仓库名。")
        user = ("用户需求：%s\n\n候选仓库（JSON 数组）：\n%s\n\n"
                "请为每个候选打相关度分（0-100，仅看功能是否满足需求，不看 star 多少），"
                "并给一句不超过 40 个汉字的中文理由，说明它为什么（不）匹配。"
                "按 score 从高到低输出 JSON 数组，元素形如 "
                "{\"full_name\":\"...\",\"score\":88,\"reason\":\"...\"}。"
                "只输出 JSON 数组本身，不要代码块、不要任何解释。"
                % (query[:500], json.dumps(cands, ensure_ascii=False)))
        try:
            content = llm_chat(base, key, model,
                               [{"role": "system", "content": system},
                                {"role": "user", "content": user}],
                               timeout=LLM_TIMEOUT)
        except urllib.error.HTTPError as e:
            return self._send_json(200, {"ok": False, "fallback": True,
                                         "reason": "upstream_error", "detail": "http_%d" % e.code})
        except Exception as e:
            reason = "timeout" if isinstance(e, TimeoutError) else "upstream_error"
            return self._send_json(200, {"ok": False, "fallback": True, "reason": reason})
        try:
            arr = extract_json_array(content)
        except Exception:
            return self._send_json(200, {"ok": False, "fallback": True, "reason": "parse_failed"})
        # 三重净化：① full_name 必须在候选集（幻觉仓库丢弃）② score clamp 0-100 ③ reason 截断 40 字
        allowed = {c["full_name"] for c in cands}
        out = []
        for it in arr:
            fn = (it or {}).get("full_name")
            if not fn or fn not in allowed:
                continue
            try:
                sc = int(float(it.get("score", 0)))
            except Exception:
                sc = 0
            sc = max(0, min(100, sc))
            rs = str(it.get("reason") or "")[:40]
            out.append({"full_name": fn, "score": sc, "reason": rs})
        if not out:
            return self._send_json(200, {"ok": False, "fallback": True, "reason": "parse_failed"})
        out.sort(key=lambda x: x["score"], reverse=True)
        return self._send_json(200, {"ok": True, "fallback": False, "model": model,
                                     "ms": int((time.time() - t0) * 1000), "ranked": out})

    def api_signup(self, body):
        if not REGISTER_OPEN:
            return self._send_json(403, {"error": "注册已关闭，请联系管理员获取邀请"})
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        invite = (body.get("invite") or "").strip()
        if not username or not password:
            return self._send_json(400, {"error": "用户名和密码必填"})
        if len(password) < 6:
            return self._send_json(400, {"error": "密码至少 6 位"})
        if STORE:
            try:
                token, uname = STORE.signup(username, password,
                                            invite if REGISTER_REQUIRE_INVITE else "")
            except STORE.ConflictError:
                return self._send_json(409, {"error": "用户名已存在"})
            except STORE.AuthError as e:
                return self._send_json(400, {"error": "注册失败: %s" % e})
            except Exception as e:
                return self._send_json(500, {"error": "注册失败: %s" % e})
            return self._send_json(200, {"token": token, "username": uname})
        # ---- 原 SQLite 分支（兜底） ----
        if REGISTER_REQUIRE_INVITE:
            if not invite:
                return self._send_json(400, {"error": "需要邀请码"})
            conn = db()
            row = conn.execute("SELECT code, used_by FROM invites WHERE code=?", (invite,)).fetchone()
            conn.close()
            if not row or row["used_by"]:
                return self._send_json(400, {"error": "邀请码无效或已使用"})
        with db_lock:
            conn = db()
            if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
                conn.close()
                return self._send_json(409, {"error": "用户名已存在"})
            uid = secrets.token_hex(16)
            salt = secrets.token_hex(16)
            verifier = pw_hash(password, salt)
            token = secrets.token_hex(32)
            exp = int(time.time()) + TOKEN_TTL
            conn.execute(
                "INSERT INTO users(uid,username,salt,verifier,token,token_exp) VALUES(?,?,?,?,?,?)",
                (uid, username, salt, verifier, token, exp),
            )
            if REGISTER_REQUIRE_INVITE and invite:
                conn.execute("UPDATE invites SET used_by=?, used_at=? WHERE code=?",
                             (uid, int(time.time()), invite))
            conn.commit()
            conn.close()
        return self._send_json(200, {"token": token, "username": username})

    def api_login(self, body):
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if STORE:
            res = STORE.login(username, password)
            if not res:
                return self._send_json(401, {"error": "用户名或密码错误"})
            token, uname = res
            return self._send_json(200, {"token": token, "username": uname})
        # ---- 原 SQLite 分支（兜底） ----
        conn = db()
        row = conn.execute(
            "SELECT uid,salt,verifier,token,token_exp FROM users WHERE username=?", (username,)
        ).fetchone()
        conn.close()
        if not row or pw_hash(password, row["salt"]) != row["verifier"]:
            return self._send_json(401, {"error": "用户名或密码错误"})
        if (row["token_exp"] or 0) < int(time.time()) or not row["token"]:
            token = secrets.token_hex(32)
            exp = int(time.time()) + TOKEN_TTL
            with db_lock:
                c = db()
                c.execute("UPDATE users SET token=?,token_exp=? WHERE uid=?", (token, exp, row["uid"]))
                c.commit()
                c.close()
        else:
            token = row["token"]
        return self._send_json(200, {"token": token, "username": username})

    def api_refresh(self, uid):
        """刷新（轮换）当前 token，延长有效期。旧 token 立即失效。"""
        if STORE:
            try:
                new_token, uname = STORE.refresh_token(uid)
            except Exception as e:
                return self._send_json(500, {"error": "刷新失败: %s" % e})
            return self._send_json(200, {"token": new_token, "username": uname})
        # ---- 原 SQLite 分支（兜底） ----
        new_token = secrets.token_hex(32)
        exp = int(time.time()) + TOKEN_TTL
        with db_lock:
            c = db()
            c.execute("UPDATE users SET token=?,token_exp=? WHERE uid=?", (new_token, exp, uid))
            c.commit()
            c.close()
        return self._send_json(200, {"token": new_token, "username": apiUser_name(uid)})

    def api_logout(self, uid):
        if STORE:
            try:
                STORE.logout(uid)
            except Exception as e:
                return self._send_json(500, {"error": "登出失败: %s" % e})
            return self._send_json(200, {"ok": True})
        # ---- 原 SQLite 分支（兜底） ----
        with db_lock:
            c = db()
            c.execute("UPDATE users SET token=NULL,token_exp=NULL WHERE uid=?", (uid,))
            c.commit()
            c.close()
        return self._send_json(200, {"ok": True})

    # ----- 第三方登录：QQ / 微信 OAuth2 -----
    def _oauth_base_url(self):
        """推断前端访问的 base URL（用于构建回调地址）。"""
        host = self.headers.get("Host", "127.0.0.1:%d" % PORT)
        proto = "http"  # 本地服务都是 http
        return "%s://%s" % (proto, host)

    def api_oauth_login(self, provider):
        """发起第三方登录：返回授权 URL + state。"""
        if provider == "qq":
            app_id, app_secret = QQ_APP_ID, QQ_APP_SECRET
            if not app_id:
                return self._send_json(501, {"error": "QQ 登录未配置（需设 QQ_APP_ID / QQ_APP_SECRET）"})
            base = self._oauth_base_url()
            redirect = base + "/api/auth/qq/callback"
            state = secrets.token_urlsafe(16)
            auth_url = ("https://graph.qq.com/oauth2.0/authorize?response_type=code"
                        "&client_id=%s&redirect_uri=%s&scope=get_user_info&state=%s") % (
                        app_id, urllib.parse.quote(redirect, safe=""), state)
        elif provider == "wechat":
            app_id, app_secret = WECHAT_APP_ID, WECHAT_APP_SECRET
            if not app_id:
                return self._send_json(501, {"error": "微信登录未配置（需设 WECHAT_APP_ID / WECHAT_APP_SECRET）"})
            base = self._oauth_base_url()
            redirect = base + "/api/auth/wechat/callback"
            state = secrets.token_urlsafe(16)
            auth_url = ("https://open.weixin.qq.com/connect/qrconnect"
                        "?appid=%s&redirect_uri=%s&response_type=code"
                        "&scope=snsapi_login&state=%s#wechat_redirect") % (
                        app_id, urllib.parse.quote(redirect, safe=""), state)
        else:
            return self._send_json(400, {"error": "不支持的登录方式: %s" % provider})
        with _oauth_lock:
            _oauth_sessions[state] = {"provider": provider, "created_at": time.time(), "result": None}
        now = time.time()
        for s in list(_oauth_sessions.keys()):
            if now - _oauth_sessions[s].get("created_at", 0) > 300:
                del _oauth_sessions[s]
        return self._send_json(200, {"auth_url": auth_url, "state": state})

    def api_oauth_callback(self, provider):
        """处理 OAuth 回调：用 code 换 token → 获取用户信息 → 创建/查找账号 → 签发 token。"""
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        code = (qs.get("code") or [""])[0]
        state = (qs.get("state") or [""])[0]
        if not code:
            return self._send_json(400, {"error": "缺少 code 参数"})
        with _oauth_lock:
            sess = _oauth_sessions.get(state)
        if not sess or sess["provider"] != provider:
            return self._send_json(400, {"error": "无效或过期的 state"})
        try:
            if provider == "qq":
                result = self._qq_exchange(code)
            elif provider == "wechat":
                result = self._wechat_exchange(code)
            else:
                return self._send_json(400, {"error": "不支持的 provider"})
            if result.get("error"):
                with _oauth_lock:
                    _oauth_sessions[state]["result"] = {"ok": False, "error": result["error"]}
                return self._send_json(302, "", headers={"Location": self._oauth_base_url() + "/"})
            openid = result["openid"]
            union_key = "oauth:%s:%s" % (provider, openid)
            conn = db()
            row = conn.execute("SELECT uid FROM users WHERE username=?", (union_key,)).fetchone()
            if row:
                uid = row["uid"]
            else:
                nickname = result.get("nickname", "用户")
                base_name = union_key
                username = base_name
                idx = 1
                while conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
                    username = "%s_%d" % (base_name, idx); idx += 1
                token = secrets.token_urlsafe(32)
                salt = os.urandom(16).hex()
                phash = hashlib.pbkdf2_hmac("sha256", os.urandom(32).hex().encode(), salt.encode(), 200000).hex()
                exp = int(time.time()) * 1000 + 2592000000
                cursor = conn.execute("INSERT INTO users(username,password_hash,salt,token,token_exp) VALUES(?,?,?,?,?)",
                                    (username, phash, salt, token, exp))
                uid = cursor.lastrowid
                conn.commit()
            conn.close()
            new_token = secrets.token_urlsafe(32)
            exp = int(time.time()) * 1000 + 2592000000
            conn = db()
            conn.execute("UPDATE users SET token=?,token_exp=? WHERE uid=?", (new_token, exp, uid))
            conn.commit()
            user_row = conn.execute("SELECT username FROM users WHERE uid=?", (uid,)).fetchone()
            conn.close()
            username = user_row["username"] if user_row else "unknown"
            with _oauth_lock:
                _oauth_sessions[state]["result"] = {"ok": True, "token": new_token, "username": username}
            return self._send_json(302, "", headers={"Location": self._oauth_base_url() + "/"})
        except Exception as e:
            with _oauth_lock:
                _oauth_sessions[state]["result"] = {"ok": False, "error": str(e)}
            return self._send_json(500, {"error": "OAuth 处理失败: %s" % e})

    def _qq_exchange(self, code):
        """用 QQ 授权码换取用户信息。"""
        base = self._oauth_base_url()
        redirect = base + "/api/auth/qq/callback"
        tok_url = ("https://graph.qq.com/oauth2.0/token?grant_type=authorization_code"
                   "&client_id=%s&client_secret=%s&code=%s&redirect_uri=%s") % (
                   QQ_APP_ID, QQ_APP_SECRET, code, urllib.parse.quote(redirect, safe=""))
        try:
            r = urllib.request.urlopen(tok_url, timeout=15).read().decode()
            params = dict(parse_qs(r))
            access_token = (params.get("access_token") or [""])[0]
        except Exception as e:
            return {"error": "QQ 获取 access_token 失败: %s" % e}
        try:
            r = urllib.request.urlopen(
                "https://graph.qq.com/oauth2.0/me?access_token=" + access_token, timeout=10).read().decode()
            m = re.search(r'"openid"\s*:\s*"([^"]+)"', r)
            openid = m.group(1) if m else ""
        except Exception as e:
            return {"error": "QQ 获取 openid 失败: %s" % e}
        try:
            info_url = ("https://graph.qq.com/user/get_user_info?access_token=%s&openid=%s"
                        "&oauth_consumer_key=%s") % (access_token, openid, QQ_APP_ID)
            r = urllib.request.urlopen(info_url, timeout=10).read().decode()
            info = json.loads(r)
            nickname = info.get("nickname", "QQ用户")
        except Exception:
            nickname = "QQ用户"
        return {"openid": openid, "nickname": nickname}

    def _wechat_exchange(self, code):
        """用微信授权码换取用户信息。"""
        tok_url = ("https://api.weixin.qq.com/sns/oauth2/access_token?appid=%s"
                   "&secret=%s&code=%s&grant_type=authorization_code") % (
                   WECHAT_APP_ID, WECHAT_APP_SECRET, code)
        try:
            r = urllib.request.urlopen(tok_url, timeout=15).read().decode()
            data = json.loads(r)
            if "errcode" in data:
                return {"error": "微信获取 token 失败: %s" % data.get("errmsg", "")}
            access_token = data["access_token"]
            openid = data["openid"]
        except Exception as e:
            return {"error": "微信请求失败: %s" % e}
        try:
            info_url = ("https://api.weixin.qq.com/sns/userinfo?access_token=%s&openid=%s") % (
                        access_token, openid)
            r = urllib.request.urlopen(info_url, timeout=10).read().decode()
            info = json.loads(r)
            if "errcode" in info:
                return {"error": "微信获取用户信息失败: %s" % info.get("errmsg", "")}
            nickname = info.get("nickname", "微信用户")
        except Exception:
            nickname = "微信用户"
        return {"openid": openid, "nickname": nickname}

    def api_oauth_result(self, provider):
        """前端轮询：查询 OAuth 登录结果。"""
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        state = (qs.get("state") or [""])[0]
        with _oauth_lock:
            sess = _oauth_sessions.get(state)
        if not sess:
            return self._send_json(404, {"error": "无效的会话"})
        result = sess.get("result")
        if result is None:
            return self._send_json(202, {"ok": False, "waiting": True})
        return self._send_json(200, result)

    def api_pull(self, uid):
        if STORE:
            try:
                payload, updated = STORE.pull_payload(uid)
            except Exception as e:
                return self._send_json(500, {"error": "拉取失败: %s" % e})
            return self._send_json(200, {"payload": payload, "updated": updated})
        conn = db()
        row = conn.execute("SELECT payload,updated FROM sync WHERE uid=?", (uid,)).fetchone()
        conn.close()
        if not row or not row["payload"]:
            return self._send_json(200, {"payload": {"times": [], "ideas": [], "notes": [], "diary": [], "cog_reads": [], "cog_books": [], "cog_thoughts": [], "cog_reviews": [], "cog_expr": [], "cog_annos": [], "directions": [], "reviews": [], "settings": {}},
                                         "updated": row["updated"] if row else 0})
        try:
            payload = json.loads(row["payload"])
        except Exception:
            payload = {"times": [], "ideas": [], "settings": {}}
        return self._send_json(200, {"payload": payload, "updated": row["updated"]})

    def api_push(self, uid, body):
        inc = body.get("payload") or {}
        if STORE:
            try:
                updated = STORE.push_payload(uid, inc)
            except STORE.CasConflict:
                return self._send_json(409, {"error": "同步冲突，请稍后重试"})
            except Exception as e:
                return self._send_json(500, {"error": "推送失败: %s" % e})
            notify(uid, "sync")
            return self._send_json(200, {"ok": True, "updated": updated})
        # ---- 原 SQLite 分支（兜底） ----
        inc_times = inc.get("times") or []
        inc_ideas = inc.get("ideas") or []
        inc_notes = inc.get("notes") or []
        inc_diary = inc.get("diary") or []
        inc_cog_reads = inc.get("cog_reads") or []
        inc_cog_books = inc.get("cog_books") or []
        inc_cog_thoughts = inc.get("cog_thoughts") or []
        inc_cog_reviews = inc.get("cog_reviews") or []
        inc_cog_expr = inc.get("cog_expr") or []
        inc_cog_annos = inc.get("cog_annos") or []
        inc_directions = inc.get("directions") or []
        inc_reviews = inc.get("reviews") or []
        inc_settings = inc.get("settings") or {}
        with db_lock:
            conn = db()
            row = conn.execute("SELECT payload FROM sync WHERE uid=?", (uid,)).fetchone()
            cur = {}
            if row and row["payload"]:
                try:
                    cur = json.loads(row["payload"])
                except Exception:
                    cur = {}
            new_payload = {
                "times": merge_records(cur.get("times") or [], inc_times),
                "ideas": merge_records(cur.get("ideas") or [], inc_ideas),
                "notes": merge_records(cur.get("notes") or [], inc_notes),
                "diary": merge_records(cur.get("diary") or [], inc_diary),
                "cog_reads": merge_records(cur.get("cog_reads") or [], inc_cog_reads),
                "cog_books": merge_records(cur.get("cog_books") or [], inc_cog_books),
                "cog_thoughts": merge_records(cur.get("cog_thoughts") or [], inc_cog_thoughts),
                "cog_reviews": merge_records(cur.get("cog_reviews") or [], inc_cog_reviews),
                "cog_expr": merge_records(cur.get("cog_expr") or [], inc_cog_expr),
                "cog_annos": merge_records(cur.get("cog_annos") or [], inc_cog_annos),
                "directions": merge_records(cur.get("directions") or [], inc_directions),
                "reviews": merge_records(cur.get("reviews") or [], inc_reviews),
                "settings": {**(cur.get("settings") or {}),
                             **{k: v for k, v in inc_settings.items() if v}},
            }
            updated = int(time.time())
            conn.execute(
                "INSERT INTO sync(uid,payload,updated) VALUES(?,?,?) "
                "ON CONFLICT(uid) DO UPDATE SET payload=excluded.payload, updated=excluded.updated",
                (uid, json.dumps(new_payload, ensure_ascii=False), updated),
            )
            conn.commit()
            conn.close()
        notify(uid, "sync")
        return self._send_json(200, {"ok": True, "updated": updated})

    # ----- 管理后台 -----
    def require_admin(self):
        t = self.headers.get("X-Admin-Token", "").strip()
        if not ADMIN_TOKEN:
            return False
        return secrets.compare_digest(t, ADMIN_TOKEN)

    def api_admin_stats(self):
        if STORE:
            s = STORE.count_stats()
            db_size = os.path.getsize(DB) if os.path.exists(DB) else 0
            return self._send_json(200, {
                "version": VERSION,
                "storage_backend": "supabase",
                "users": s.get("users", 0),
                "users_with_sync": s.get("syncs", 0),
                "invites_total": s.get("invites_total", 0),
                "invites_used": s.get("invites_used", 0),
                "register_open": REGISTER_OPEN,
                "github_proxy": bool(GH_TOKEN or GH_PROXY_DICT),
                "db_size_bytes": db_size,
                "backup_dir": BACKUP_DIR,
            })
        conn = db()
        users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        syncs = conn.execute("SELECT COUNT(*) AS c FROM sync").fetchone()["c"]
        invites_total = conn.execute("SELECT COUNT(*) AS c FROM invites").fetchone()["c"]
        invites_used = conn.execute("SELECT COUNT(*) AS c FROM invites WHERE used_by IS NOT NULL").fetchone()["c"]
        conn.close()
        db_size = os.path.getsize(DB) if os.path.exists(DB) else 0
        return self._send_json(200, {
            "version": VERSION,
            "storage_backend": "sqlite",
            "users": users,
            "users_with_sync": syncs,
            "invites_total": invites_total,
            "invites_used": invites_used,
            "register_open": REGISTER_OPEN,
            "github_proxy": bool(GH_TOKEN or GH_PROXY_DICT),
            "db_size_bytes": db_size,
            "backup_dir": BACKUP_DIR,
        })

    def api_admin_users(self):
        if STORE:
            rows = STORE.list_users()
            return self._send_json(200, {"users": [
                {"uid": r.get("uid"), "username": r.get("username")}
                for r in rows
            ]})
        conn = db()
        rows = conn.execute("SELECT uid,username,token_exp FROM users ORDER BY username").fetchall()
        conn.close()
        now = int(time.time())
        return self._send_json(200, {"users": [
            {"uid": r["uid"], "username": r["username"],
             "token_expired": bool(r["token_exp"] and r["token_exp"] < now)}
            for r in rows
        ]})

    def api_admin_set_register(self, body):
        global REGISTER_OPEN
        REGISTER_OPEN = bool(body.get("open"))
        return self._send_json(200, {"register_open": REGISTER_OPEN})

    def api_admin_reset_token(self, body):
        username = (body.get("username") or "").strip()
        if not username:
            return self._send_json(400, {"error": "username 必填"})
        if STORE:
            STORE.reset_token_by_username(username)
            return self._send_json(200, {"ok": True})
        with db_lock:
            c = db()
            n = c.execute("UPDATE users SET token=NULL,token_exp=NULL WHERE username=?",
                          (username,)).rowcount
            c.commit()
            c.close()
        if n == 0:
            return self._send_json(404, {"error": "用户不存在"})
        return self._send_json(200, {"ok": True})

    # ----- 路由 -----
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/api/health":
            return self._send_json(200, {"ok": True, "github_proxy": bool(GH_TOKEN or GH_PROXY_DICT),
                                         "proxy": GH_PROXY_DICT or (GH_TOKEN and "GH_TOKEN")})
        if p == "/api/config":
            return self.api_config()
        if p == "/api/sync/stream":
            uid = auth_user(bearer(self))
            if not uid:
                return self._send_json(401, {"error": "未登录"})
            return self.sync_stream(uid)
        if p == "/api/sync/pull":
            uid = auth_user(bearer(self))
            if not uid:
                return self._send_json(401, {"error": "未登录"})
            return self.api_pull(uid)
        if p == "/api/admin/stats":
            if not self.require_admin():
                return self._send_json(403, {"error": "无管理权限或未启用"})
            return self.api_admin_stats()
        if p == "/api/admin/users":
            if not self.require_admin():
                return self._send_json(403, {"error": "无管理权限或未启用"})
            return self.api_admin_users()
        if p == "/api/github/search":
            ok, retry = github_limiter.allow("gh:" + client_ip(self))
            if not ok:
                return self._send_json(429, {"error": "GitHub 搜索过于频繁，请 %d 秒后再试" % retry})
            q = parse_qs(u.query)
            qv = (q.get("q") or [""])[0]
            if not qv:
                return self._send_json(400, {"error": "缺少 q 参数"})
            params = {"q": qv}
            # per_page：默认 30，放宽到 GitHub 硬上限 100（多路召回用 50）
            try:
                pp = int((q.get("per_page") or ["30"])[0])
            except ValueError:
                pp = 30
            params["per_page"] = str(max(1, min(100, pp)))
            # sort：不传 / 传空 / 非法值 => 不拼 sort 参数，交给 GitHub best-match 相关度排序
            sort = (q.get("sort") or [""])[0].strip().lower()
            if sort in ("stars", "forks", "help-wanted-issues", "updated"):
                params["sort"] = sort
                order = (q.get("order") or ["desc"])[0].strip().lower()
                params["order"] = order if order in ("asc", "desc") else "desc"
            return self.github_search(params, dict(self.headers))
        # ----- OAuth 第三方登录 -----
        if p == "/api/auth/qq/login":
            return self.api_oauth_login("qq")
        if p == "/api/auth/wechat/login":
            return self.api_oauth_login("wechat")
        if p == "/api/auth/qq/callback":
            return self.api_oauth_callback("qq")
        if p == "/api/auth/wechat/callback":
            return self.api_oauth_callback("wechat")
        if p == "/api/auth/qq/result":
            return self.api_oauth_result("qq")
        if p == "/api/auth/wechat/result":
            return self.api_oauth_result("wechat")
        return self.serve_static(p)

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        body = self._read_body()
        if p == "/api/auth/signup":
            ok, retry = auth_limiter.allow("auth:" + client_ip(self))
            if not ok:
                return self._send_json(429, {"error": "尝试过于频繁，请 %d 秒后再试" % retry})
            return self.api_signup(body)
        if p == "/api/auth/login":
            ok, retry = auth_limiter.allow("auth:" + client_ip(self))
            if not ok:
                return self._send_json(429, {"error": "尝试过于频繁，请 %d 秒后再试" % retry})
            return self.api_login(body)
        if p == "/api/auth/refresh":
            uid = auth_user(bearer(self))
            if not uid:
                return self._send_json(401, {"error": "未登录"})
            return self.api_refresh(uid)
        if p == "/api/auth/logout":
            uid = auth_user(bearer(self))
            if not uid:
                return self._send_json(401, {"error": "未登录"})
            return self.api_logout(uid)
        if p == "/api/sync/push":
            uid = auth_user(bearer(self))
            if not uid:
                return self._send_json(401, {"error": "未登录"})
            return self.api_push(uid, body)
        if p == "/api/admin/set-register":
            if not self.require_admin():
                return self._send_json(403, {"error": "无管理权限或未启用"})
            return self.api_admin_set_register(body)
        if p == "/api/admin/reset-token":
            if not self.require_admin():
                return self._send_json(403, {"error": "无管理权限或未启用"})
            return self.api_admin_reset_token(body)
        if p == "/api/admin/backup":
            if not self.require_admin():
                return self._send_json(403, {"error": "无管理权限或未启用"})
            do_backup()
            return self._send_json(200, {"ok": True})
        if p == "/api/search/rerank":
            return self.api_search_rerank(body)
        return self._send_json(404, {"error": "not found"})


def apiUser_name(uid):
    if STORE:
        return STORE.get_username(uid)
    conn = db()
    row = conn.execute("SELECT username FROM users WHERE uid=?", (uid,)).fetchone()
    conn.close()
    return row["username"] if row else ""


def main():
    global STORE
    # --- Phase 2：Supabase 存储后端初始化（失败自动回退本地 SQLite，不崩服务） ---
    if STORAGE_BACKEND == "supabase" and supabase_store is not None:
        try:
            info = supabase_store.init_and_selfcheck()
            STORE = supabase_store
            _p("✅ 已接入 Supabase 存储后端: %s（profiles=%s）" % (
                SUPABASE_URL, info.get("profiles_count")))
            # R-04 Free 档 7 天暂停兜底：每 12h 轻查询保活
            def _keepalive_loop():
                while True:
                    time.sleep(12 * 3600)
                    try:
                        supabase_store.keepalive()
                    except Exception:
                        pass
            threading.Thread(target=_keepalive_loop, daemon=True).start()
        except Exception as e:
            STORE = None
            _p("⚠️ Supabase 初始化失败，回退本地 SQLite:", e)
    elif STORAGE_BACKEND == "supabase":
        _p("⚠️ supabase_store 模块未加载，回退本地 SQLite")
    init_db()
    do_backup()  # 启动时先备一份
    if BACKUP_INTERVAL > 0:
        threading.Thread(target=backup_loop, daemon=True).start()
    port = PORT
    httpd = None
    last_err = None
    for _ in range(11):  # 依次尝试 8000..8010，避免端口被占用导致启动失败
        try:
            ThreadingHTTPServer.allow_reuse_address = False
            httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
            break
        except OSError as e:
            last_err = e
            port += 1
    if not httpd:
        _p("❌ 无法启动：端口 %d-%d 均被占用：%s" % (PORT, PORT + 10, last_err))
        return
    _p(f"✅ 工作台后端已启动: http://localhost:{port}")
    _p(f"   GitHub 代理: {'已配置(' + json.dumps(GH_PROXY_DICT) + ')' if GH_PROXY_DICT else ('已配置 GH_TOKEN' if GH_TOKEN else '未配置（浏览器直连 GitHub 通常被墙）')}")
    _p(f"   公开注册: {'开启' if REGISTER_OPEN else '关闭'}" + ("（需邀请码）" if REGISTER_REQUIRE_INVITE else ""))
    _p(f"   管理后台: {'已启用' if ADMIN_TOKEN else '未启用'}")
    _p(f"   自动备份: {'每 %d 秒' % BACKUP_INTERVAL if BACKUP_INTERVAL > 0 else '关闭'}")
    _p(f"   QQ 登录: {'已配置 (AppID ' + QQ_APP_ID + ')' if (QQ_APP_ID and QQ_APP_SECRET) else '未配置'}")
    _p(f"   微信登录: {'已配置 (AppID ' + WECHAT_APP_ID + ')' if (WECHAT_APP_ID and WECHAT_APP_SECRET) else '未配置'}")
    _p(f"   配置文件: {'、'.join(ENV_FILES_LOADED) if ENV_FILES_LOADED else '未加载（可在 wb.env 中填写配置）'}")
    _p(f"   数据文件: {DB}")
    _p(f"   存储后端: {'Supabase（{0}）'.format(SUPABASE_URL) if STORE else '本地 SQLite'}")
    if os.environ.get("OPEN_BROWSER", "0") == "1":
        try:
            import webbrowser
            webbrowser.open(f"http://localhost:{port}")
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        _p("\n已停止")
        httpd.shutdown()


if __name__ == "__main__":
    main()
