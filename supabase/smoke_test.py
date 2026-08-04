# -*- coding: utf-8 -*-
"""Phase 2 端到端冒烟测试（连真库）。

覆盖：
  A. init_and_selfcheck（连表验证）
  B. signup（admin 建号 + profiles + sync + token）
  C. login（口令校验 + 自签 JWT）
  D. pull（空 payload）
  E. push（写入业务数据）
  F. pull 回读（数据 + settings 合并校验）
  G. CAS 并发冲突（双线程 push，验证 retry 兜底）
  H. token_epoch 撤销（refresh 后旧 token 失效）
  I. 清理测试用户

用法（在项目根目录）：
  python supabase/smoke_test.py
退出码：0=全过，1=有失败。
"""
import os, sys, time, json, threading, traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(path):
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and not os.environ.get(k):
                    os.environ[k] = v


# 加载 .env / wb.env（server.py 用的同一份配置）
load_env(os.path.join(ROOT, ".env"))
load_env(os.path.join(ROOT, "wb.env"))

sys.path.insert(0, ROOT)
import supabase_store as S  # noqa: E402
import jwt  # noqa: E402


def section(name):
    print()
    print("=" * 60)
    print("  " + name)
    print("=" * 60)


def ok(msg):
    print("  [OK] " + msg)


def fail(msg, e=None):
    print("  [FAIL] " + msg)
    if e is not None:
        traceback.print_exc()
    raise SystemExit(1)


# ----- Phase A -----
section("Phase A: init_and_selfcheck（连表验证）")
try:
    info = S.init_and_selfcheck()
    ok(u"连接成功，profiles 采样返回 {0} 行（表存在即通过）".format(info.get("profiles_count")))
except Exception as e:
    fail(u"连接失败：{0}".format(e), e)


# ----- Phase B -----
section("Phase B: signup（admin 建号 + profiles + sync + 自签 token）")
ts = int(time.time())
test_user = u"smoketest_{0}".format(ts)
test_pass = "SmokeTest#2026"
test_uid = None
try:
    token, username = S.signup(test_user, test_pass, "")
    claims = jwt.decode(token, S.JWT_SECRET, algorithms=["HS256"],
                        audience=S.JWT_AUD, issuer=S.JWT_ISS)
    test_uid = claims["sub"]
    ok(u"注册成功：username={0}, uid={1}".format(username, test_uid))
    ok(u"token 含 sub/epo/exp 字段：epo={0}".format(claims.get("epo")))
except S.ConflictError as e:
    fail(u"用户名冲突：{0}".format(e), e)
except Exception as e:
    fail(u"注册失败：{0}".format(e), e)


# ----- Phase C -----
section("Phase C: login（匿名 client 校验口令 + 自签 JWT）")
try:
    token2, uname2 = S.login(test_user, test_pass)
    assert token2 is not None, "登录返回 None"
    ok(u"登录成功，username={0}".format(uname2))
    verified = S.verify_token(token2)
    assert verified == test_uid, u"token 验证不通过：{0} != {1}".format(verified, test_uid)
    ok("verify_token(新 token) == uid")
except Exception as e:
    fail(u"登录失败：{0}".format(e), e)


# ----- Phase D -----
section("Phase D: 首次 pull（空 payload）")
try:
    payload, updated = S.pull_payload(test_uid)
    expected_keys = {"times", "ideas", "notes", "diary",
                     "cog_reads", "cog_books", "cog_thoughts", "cog_reviews",
                     "directions", "reviews", "settings"}
    missing = expected_keys - set(payload.keys())
    assert not missing, u"payload 缺键：{0}".format(missing)
    ok(u"pull 返回完整空骨架（11 个键齐全），updated={0}".format(updated))
except Exception as e:
    fail(u"pull 失败：{0}".format(e), e)


# ----- Phase E -----
section("Phase E: push 写入测试数据")
try:
    inc = {
        "times": [
            {"id": "t1", "cat": "work", "start": ts, "end": ts + 3600,
             "note": "smoke-test", "deviceId": "smoke-1", "updatedAt": ts},
        ],
        "settings": {"theme": "dark", "lang": "zh"},
    }
    updated = S.push_payload(test_uid, inc)
    ok(u"push 成功，updated={0}".format(updated))
    S.init()
    r = S._svc().table("sync").select("payload_version").eq("uid", test_uid).limit(1).execute()
    ver = r.data[0]["payload_version"]
    ok(u"sync.payload_version = {0}（应为 1）".format(ver))
    assert ver == 1, u"payload_version 期望 1，实际 {0}".format(ver)
except Exception as e:
    fail(u"push 失败：{0}".format(e), e)


# ----- Phase F -----
section("Phase F: 二次 pull 回读（校验合并）")
try:
    payload, updated = S.pull_payload(test_uid)
    times = payload.get("times", [])
    settings = payload.get("settings", {})
    assert len(times) == 1 and times[0]["id"] == "t1", u"times 合并异常：{0}".format(times)
    assert settings.get("theme") == "dark" and settings.get("lang") == "zh", \
        u"settings 合并异常：{0}".format(settings)
    ok(u"回读校验通过：times=1 条、settings 含 theme=dark / lang=zh")
except Exception as e:
    fail(u"回读校验失败：{0}".format(e), e)


# ----- Phase G -----
section("Phase G: CAS 并发冲突（双线程 push，验证 retry 兜底）")
results = {}
barrier = threading.Barrier(2)


def cas_worker(name, inc):
    barrier.wait()
    try:
        u = S.push_payload(test_uid, inc)
        results[name] = ("ok", u)
    except Exception as e:
        results[name] = ("err", str(e))


try:
    inc_a = {"times": [{"id": "ca", "cat": "study", "start": ts,
                         "end": ts + 1800, "note": "cas-a",
                         "deviceId": "smoke-A", "updatedAt": ts + 1}]}
    inc_b = {"times": [{"id": "cb", "cat": "life", "start": ts,
                         "end": ts + 1200, "note": "cas-b",
                         "deviceId": "smoke-B", "updatedAt": ts + 2}]}
    threads = [
        threading.Thread(target=cas_worker, args=("A", inc_a)),
        threading.Thread(target=cas_worker, args=("B", inc_b)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    print(u"  worker 结果：A={0}, B={1}".format(results.get("A"), results.get("B")))
    assert results.get("A", ("err", ""))[0] == "ok", "worker A 失败"
    assert results.get("B", ("err", ""))[0] == "ok", "worker B 失败"

    payload, _ = S.pull_payload(test_uid)
    ids = sorted(t["id"] for t in payload.get("times", []))
    assert ids == ["ca", "cb", "t1"], u"并发后合并结果异常：{0}".format(ids)
    ok(u"CAS 冲突通过 retry 兜底，两条 ca/cb 都已合并进 payload")
except Exception as e:
    fail(u"CAS 并发测试失败：{0}".format(e), e)


# ----- Phase H -----
section("Phase H: token_epoch 撤销（refresh 后旧 token 失效）")
old_token = token2
try:
    new_token, uname = S.refresh_token(test_uid)
    ok("refresh_token 成功")
    old_valid = S.verify_token(old_token)
    assert old_valid is None, u"旧 token 应被拒绝（epoch 已 bump）"
    ok("旧 token 已被撤销")
    new_valid = S.verify_token(new_token)
    assert new_valid == test_uid, "新 token 应通过验证"
    ok("新 token 验证通过")
except Exception as e:
    fail(u"token 撤销测试失败：{0}".format(e), e)


# ----- Phase I -----
section("Phase I: 清理测试用户")
try:
    S.init()
    S._svc().table("sync").delete().eq("uid", test_uid).execute()
    S._svc().table("profiles").delete().eq("uid", test_uid).execute()
    try:
        S._svc().auth.admin.delete_user(test_uid)
    except Exception:
        pass
    ok(u"测试用户 {0}（uid={1}）已清理".format(test_user, test_uid))
except Exception as e:
    print(u"  [WARN] 清理失败（可手动清）：{0}".format(e))


print()
print(u"=" * 60)
print(u"  \u2728 全部冒烟测试通过！Supabase 后端实链路可用。")
print(u"=" * 60)