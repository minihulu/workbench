# 原生窗口壳：用系统 WebView2 承载工作台（不是浏览器标签页）
import os, sys, time, subprocess, urllib.request, traceback, ctypes, shutil, tempfile

LOCAL = os.environ.get("LOCALAPPDATA") or tempfile.gettempdir()
LOG = os.path.join(LOCAL, "workbench_native.log")

def log(*a):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a) + "\n")
    except Exception:
        pass

def msgbox(text, title="我的工作台"):
    try:
        ctypes.windll.user32.MessageBoxW(0, str(text), title, 0x10)
    except Exception:
        pass

import webview  # 顶层 import，确保 PyInstaller 能打包


def probe_local_proxy():
    """探测本地代理，让 GitHub 搜索开箱即用。返回要注入的 GH_PROXY，或 None（无需注入）。
    判定顺序：1) 已有环境变量代理 -> 交给 server 处理；
             2) 直连 GitHub 已通（如 Clash TUN 模式）-> 无需代理；
             3) Windows 系统代理(注册表)存在 -> 交给 server 读注册表；
             4) 探测常见本地端口，能连 GitHub 就用它。"""
    for k in ("GH_PROXY", "HTTPS_PROXY", "HTTP_PROXY"):
        if os.environ.get(k):
            return None
    import urllib.request as _u
    test_url = "https://api.github.com/healthz"

    def can_reach(opener=None):
        try:
            o = opener or _u.build_opener()
            with o.open(test_url, timeout=1.5) as r:
                return r.status == 200
        except Exception:
            return False

    # 2) 直连已通（TUN 模式 / 网络层已代理）
    if can_reach():
        return None
    # 3) Windows 系统代理
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
        if enabled:
            return None
    except Exception:
        pass
    # 4) 探测常见端口
    for port in (7890, 7891, 7892, 1080, 10808, 10809, 8080):
        proxy = "http://127.0.0.1:%d" % port
        if can_reach(_u.build_opener(_u.ProxyHandler({"http": proxy, "https": proxy}))):
            return proxy
    return None



def find_python():
    cands = []
    for name in ("python", "python3", "py"):
        p = shutil.which(name)
        if p:
            cands.append(p)
    local = os.environ.get("LOCALAPPDATA", "")
    if local:
        base = os.path.join(local, "Programs", "Python")
        if os.path.isdir(base):
            for d in sorted(os.listdir(base)):
                cand = os.path.join(base, d, "python.exe")
                if os.path.isfile(cand):
                    cands.append(cand)
    wb = os.path.join(os.environ.get("USERPROFILE", ""), ".workbuddy", "binaries",
                      "python", "versions", "3.13.12", "python.exe")
    if os.path.isfile(wb):
        cands.append(wb)
    return cands[0] if cands else None


def port_busy(port):
    """毫秒级判断端口是否有人监听（避免对空端口做慢速 HTTP 探测）。"""
    import socket
    s = socket.socket()
    s.settimeout(0.08)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False
    finally:
        try:
            s.close()
        except Exception:
            pass


def probe_server(port):
    """探测端口上的服务身份。
    返回 "ours"（本项目新版服务）/ "foreign"（别的东西占用，含本项目旧版）/ None（没服务）。
    关键：旧版 server.py 没有 /api/config，会被判成 foreign，从而避免复用旧代码。
    """
    import json as _j
    if not port_busy(port):
        return None          # 端口空闲，直接返回，不做 HTTP 请求（快 ~1000 倍）
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/api/config" % port, timeout=2) as r:
            if r.status == 200:
                cfg = _j.loads(r.read().decode("utf-8", "replace"))
                if cfg.get("app") == "workbench":
                    return "ours"
            return "foreign"
    except urllib.error.HTTPError:
        return "foreign"          # 有服务但不认识这个接口（旧版或别的程序）
    except Exception:
        return None               # 端口上没人


def wait_ours(port, timeout=20):
    """等待指定端口出现「本项目新版服务」。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        if probe_server(port) == "ours":
            return True
        time.sleep(0.4)
    return False


def main():
    log("=== app start ===")
    SERVER = os.environ.get("WORKBENCH_SERVER") or r"E:\project\workbench\server.py"
    SERVER = os.path.abspath(SERVER)
    if not os.path.isfile(SERVER):
        msgbox("找不到后端服务：\n%s\n请确认工作台文件完整。" % SERVER)
        return

    proc = None
    port = None

    # 1) 先找一个「已经在跑的本项目新版服务」直接复用；旧版/异己一律不复用
    free_ports = []
    for p in range(8000, 8006):
        st = probe_server(p)
        if st == "ours":
            port = p
            log("复用已有新版服务，端口", p)
            break
        elif st == "foreign":
            log("端口", p, "被非本项目(或旧版)服务占用，跳过")
        else:
            free_ports.append(p)

    # 2) 没有可复用的，就自己拉起一个
    if port is None:
        py = find_python()
        if not py:
            msgbox("找不到 Python，无法启动本地服务。\n请先安装 Python 3。")
            return
        # 复用上一轮扫描结果，选一个真正空闲的端口，避免撞上旧服务
        start_port = free_ports[0] if free_ports else 8000
        log("python:", py, "server:", SERVER, "port:", start_port)
        env = dict(os.environ)
        env["PORT"] = str(start_port)
        env["OPEN_BROWSER"] = "0"
        # 防止子进程 print 中文/emoji 时因 GBK 控制台编码崩溃
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        gp = probe_local_proxy()
        if gp:
            env["GH_PROXY"] = gp
            log("auto GH_PROXY:", gp)
        try:
            CREATE_NO_WINDOW = 0x08000000
            proc = subprocess.Popen([py, SERVER], env=env, cwd=os.path.dirname(SERVER),
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    creationflags=CREATE_NO_WINDOW)
        except Exception as e:
            msgbox("启动本地服务失败：\n%s" % e)
            return
        log("server pid", proc.pid)
        if wait_ours(start_port, 20):
            port = start_port
        else:
            # server.py 自身也会在端口占用时顺延，这里再扫一遍
            for p in range(8000, 8006):
                if probe_server(p) == "ours":
                    port = p
                    break
        if port is None:
            msgbox("本地服务启动失败。\n日志：%s" % LOG)
            try:
                proc.terminate()
            except Exception:
                pass
            return
    log("server ready on", port)

    stopped = {"done": False}

    def on_closed():
        if stopped["done"]:
            return
        stopped["done"] = True
        log("window closed -> stop server")
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass

    try:
        # 带时间戳：即便 WebView2 有残留缓存，也强制拉取最新前端
        url = "http://127.0.0.1:%d/?_t=%d" % (port, int(time.time()))
        win = webview.create_window("我的工作台", url,
                                    width=1280, height=820, min_size=(900, 600))
        # 关键：绑定真正的「窗口关闭」事件。
        # 切勿写成 webview.start(on_closed, ...) —— start() 的首个位置参数是
        # 「GUI 启动后在后台线程执行的函数」，那样会在窗口刚打开时就把后端杀掉。
        try:
            win.events.closed += on_closed
        except Exception:
            log("bind closed event failed:", traceback.format_exc())
        # 必须 private_mode=False，否则 localStorage 不落盘 —— 工作台所有数据都在 localStorage
        store = os.path.join(LOCAL, "workbench_webview")
        os.makedirs(store, exist_ok=True)
        webview.start(debug=False, private_mode=False, storage_path=store)
    except Exception as e:
        log("webview error:", traceback.format_exc())
        msgbox("打开原生窗口失败：\n%s\n（需系统已安装 Edge WebView2 运行时）" % e)
    finally:
        on_closed()   # GUI 循环结束后兜底回收后端进程，避免留下僵尸
    log("=== app exit ===")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("FATAL", traceback.format_exc())
        msgbox("启动出错：\n%s\n详见 native_app.log" % e)
