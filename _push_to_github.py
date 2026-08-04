r"""一键把工作台代码推送到 GitHub（支持令牌无头推送）。

为什么需要这个脚本：本地提交/推送必须在你本机执行。脚本把
「整理干净分支 -> 暂存 -> 安全检查 -> 提交 -> 推送」串成一步。

怎么跑（重要）：
  请用一个「真实的命令提示符 / PowerShell」运行本脚本，不要通过
  WorkBuddy 内部的终端双击运行 —— 那个环境会拦截 git 写 .git 里的文件，
  会报 "could not write config file .git/config: Permission denied"。

  打开方式：按 Win+R -> 输入 cmd -> 回车 -> 输入下面两行：
      cd /d E:\project\workbench
      push-to-github.cmd

两种推送方式：
  A. 走 Git 凭证管家（会弹 GitHub 登录窗，授权一次即可）：
      push-to-github.cmd
  B. 带令牌无头推送（不弹窗，适合不想配凭证的情况）：
      先把下面 ghp_xxx 换成你的 Personal Access Token（只需 repo 权限）：
      set GH_TOKEN=ghp_xxx
      push-to-github.cmd

安全保障：
- 推送前逐项检查敏感文件（.env、数据库、密钥），发现就中止，绝不上传。
- 通过孤儿分支发布，仓库历史里不会包含助手本地笔记（.workbuddy/，含 Supabase 项目地址）。
"""
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
OWNER_REPO = "minihulu/workbench"
REPO_HTTPS = "https://github.com/%s.git" % OWNER_REPO
BRANCH = "main"
PUBLISH = "__publish"

# 令牌优先从环境变量读（方式 B）。为空则走凭证管家（方式 A）。
TOKEN = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or ""

# 绝不允许出现在提交里的东西
FORBIDDEN = [
    (".env", "含数据库最高权限密钥"),
    ("wb.env", "含各平台密钥"),
    (".dev.vars", "含本地开发密钥"),
    ("wb.db", "用户数据库"),
]
FORBIDDEN_SUFFIX = [(".db", "数据库文件"), (".log", "日志")]
FORBIDDEN_PREFIX = [(".workbuddy/", "助手本地笔记，含 Supabase 项目地址")]


def run(args, check=True, quiet=False):
    r = subprocess.run(
        args, cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if not quiet and r.stdout.strip():
        print(r.stdout.rstrip())
    if check and r.returncode != 0:
        err = (r.stderr or "").strip()
        # git 的 LF/CRLF 警告是噪音，不算错
        real = [l for l in err.splitlines()
                if l.strip() and not l.startswith("warning: in the working copy")]
        if real:
            print("\n".join(real))
        raise RuntimeError("命令失败: %s" % " ".join(args))
    return r


def step(n, text):
    print("\n[%d/5] %s" % (n, text))


def mask(url):
    # 把 https://TOKEN@... 显示成 https://****@...，避免令牌出现在日志里
    if "@" in url:
        head, tail = url.split("@", 1)
        return "https://****@" + tail
    return url


def main():
    print("=" * 56)
    print("  把「我的工作台」推送到 GitHub")
    print("  仓库：%s" % OWNER_REPO)
    print("=" * 56)

    if not os.path.isdir(os.path.join(ROOT, ".git")):
        print("\n[错误] 这个文件夹不是 git 仓库，位置可能不对。")
        raise SystemExit(1)

    # ---- 1. 决定推送地址（不写 .git/config）----
    if TOKEN:
        print("\n  已检测到 GH_TOKEN，将使用令牌无头推送（不弹登录窗）。")
        push_url = "https://%s@github.com/%s.git" % (TOKEN, OWNER_REPO)
    else:
        print("\n  未检测到 GH_TOKEN，将走 Git 凭证管家（可能弹登录窗）。")
        push_url = REPO_HTTPS
        # 尽量把 origin 指到正确地址；失败不致命（推送时直接用 URL）
        try:
            cur = run(["git", "remote", "get-url", "origin"], quiet=True, check=False).stdout.strip()
            if cur and cur != REPO_HTTPS:
                run(["git", "remote", "set-url", "origin", REPO_HTTPS], check=False)
        except Exception:
            pass
    print("  推送地址：%s" % mask(push_url))

    # ---- 2. 整理一个干净的孤儿分支（历史不含 .workbuddy）----
    step(2, "整理干净分支（不含助手笔记）")
    run(["git", "branch", "-D", PUBLISH], check=False, quiet=True)
    run(["git", "checkout", "--orphan", PUBLISH])
    # 清掉可能曾跟踪的 .workbuddy（被 gitignore 后其实没跟踪，失败忽略）
    run(["git", "rm", "-r", "--cached", "--quiet", ".workbuddy"], check=False, quiet=True)
    run(["git", "add", "-A"])
    staged = [s for s in run(["git", "diff", "--cached", "--name-only"], quiet=True).stdout.splitlines() if s.strip()]
    if not staged:
        print("  没有可提交的文件，可能已经在仓库里了。")
        return
    print("  待提交 %d 个文件" % len(staged))

    # ---- 3. 安全检查（发现敏感文件立即中止）----
    step(3, "安全检查：确认没有密钥被带上去")
    hits = []
    for f in staged:
        base = os.path.basename(f)
        for name, why in FORBIDDEN:
            if base == name:
                hits.append((f, why))
        for suf, why in FORBIDDEN_SUFFIX:
            if base.endswith(suf):
                hits.append((f, why))
        for pre, why in FORBIDDEN_PREFIX:
            if f.startswith(pre):
                hits.append((f, why))
    if hits:
        print("\n  [已中止] 发现不应上传的文件：")
        for f, why in hits:
            print("    - %s  （%s）" % (f, why))
        print("\n  什么都没有上传。请确认这些文件在 .gitignore 里后重试。")
        raise SystemExit(1)
    print("  通过：无 .env、无数据库、无密钥文件")

    # ---- 4. 提交 ----
    step(4, "提交")
    msg = (
        "feat(cloudflare): Pages Functions 后端 + 修复 3 处安全缺陷\n"
        "\n"
        "把 Python 后端迁移到 Cloudflare Pages Functions（TypeScript），\n"
        "前端与 /api/* 同域部署，前端代码无需改动、也不需要 CORS。\n"
        "\n"
        "新增：lib/ 六个基础模块 + functions/api/ 非同步类 12 个接口\n"
        "\n"
        "实测驱动的修复（对真实数据库做隔离实验得出，非推测）：\n"
        "数据库的 PATCH 请求在不带 Prefer: return=representation 时，\n"
        "「改到 1 行」与「改到 0 行」都返回 204 空体，无法区分成功与冲突。\n"
        "\n"
        "1. 鉴权 fail-open：查不到用户资料时按未撤销放行，\n"
        "   导致已删号用户的存量令牌 30 天内仍可通过鉴权。改为一律拒绝。\n"
        "2. 假登出：bumpTokenEpoch 按 res.ok 判成功，\n"
        "   用户不存在时也报「已登出所有设备」，实际未吊销任何令牌。\n"
        "3. 邀请码 TOCTOU：标记已用的过滤条件缺 used_by=is.null，\n"
        "   且检查与标记之间隔三次网络往返，同一个码可被多人并发用掉。\n"
        "   改为数据库层面的原子抢占 + 失败回滚。\n"
        "\n"
        "测试 71 -> 78，含跨语言金标：\n"
        "PyJWT 用 64 位十六进制字符串密钥签出的令牌，TS 侧必须验得过。\n"
        "密钥按 UTF-8 取 64 字节，若误作十六进制解码成 32 字节，\n"
        "存量令牌会全部失效且只报「凭证无效」，几乎无法反查。\n"
        "附反向断言确保该测试具备鉴别力。\n"
        "\n"
        "另修正 3 处照着旧 bug 写的 mock（它们让缺陷一直显示为通过）。\n"
    )
    run(["git", "commit", "-q", "-m", msg])
    head = run(["git", "log", "--oneline", "-1"], quiet=True).stdout.strip()
    print("  已提交：%s" % head)

    # ---- 5. 推送 ----
    step(5, "推送到 GitHub")
    print("  正在推送 ...")
    r = run(
        ["git", "push", "--force", push_url, "%s:%s" % (PUBLISH, BRANCH)],
        check=False,
    )
    if r.returncode != 0:
        print((r.stderr or "").strip())
        print("\n  [推送失败] 提交已保存在本地分支 %s，不会丢。" % PUBLISH)
        if not TOKEN:
            print("  可能原因：未登录 GitHub，或网络不通。请二选一：")
            print("    A. 运行 `gh auth login` 后重跑本脚本；或")
            print("    B. 设令牌后重跑： set GH_TOKEN=你的PAT  然后 push-to-github.cmd")
        else:
            print("  请检查令牌是否有 repo 权限、仓库地址是否正确、网络是否通。")
        raise SystemExit(1)

    # 让本地 main 也指向干净提交，保持本地一致
    run(["git", "checkout", "-B", BRANCH, PUBLISH], check=False, quiet=True)
    print("\n" + "=" * 56)
    print("  完成！代码已上传到：")
    print("  https://github.com/%s" % OWNER_REPO)
    print("=" * 56)
    print("\n  接下来去 Cloudflare 连接这个仓库即可部署，")
    print("  步骤见项目里的 CLOUDFLARE.md。")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        print("\n[git 出错] %s" % e)
        print("  若提示无法写入 .git 里的文件，说明脚本跑在了受限制的沙箱里。")
        print("  请改用真实终端：Win+R -> 输入 cmd -> 回车 -> cd /d E:\\project\\workbench -> push-to-github.cmd")
        raise SystemExit(1)
    except SystemExit:
        raise
    except Exception as e:
        print("\n[意外错误] %s: %s" % (type(e).__name__, e))
        raise SystemExit(1)
