# -*- coding: utf-8 -*-
"""
服务端同步白名单 —— PDF 批注(cog_annos) / 英语表达(cog_expr) 回归测试

背景（硬约束）：supabase_store.push_payload 是
    new_payload = {k: merge_records(...) for k in RECORD_KEYS}
只要某个 key 不在 RECORD_KEYS 里，客户端推上来的这份数据就被 **静默丢弃**，
不报错、不告警，表现为「跨端同步后批注消失」。server.py 的 SQLite 兜底分支同理。

因此这里不只断言「代码里有这个字符串」，而是：
  1) 真 import 两个模块，断言 RECORD_KEYS 内容
  2) 真跑 merge_records 验证 LWW 语义
  3) 用假的 supabase client 真跑 push_payload / pull_payload，
     断言 cog_annos 真的被写进 new_payload 而不是被白名单吃掉

运行：python tests/test_sync_annos.py
"""
import os
import sys
import ast
import json
import types
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

# supabase_store 顶部 `import jwt`(PyJWT) 只用于签发/校验登录 token，
# 与本文件要验证的 payload 白名单无关。CI/本地未装 PyJWT 时打个桩，
# 让白名单这条硬约束在任何环境都能被守住（不装依赖 == 不测 是不可接受的）。
if "jwt" not in sys.modules:
    try:
        import jwt  # noqa: F401
    except ImportError:
        _stub = types.ModuleType("jwt")
        _stub.encode = lambda *a, **k: ""
        _stub.decode = lambda *a, **k: {}
        _stub.PyJWTError = type("PyJWTError", (Exception,), {})
        _stub.ExpiredSignatureError = type("ExpiredSignatureError", (_stub.PyJWTError,), {})
        _stub.InvalidTokenError = type("InvalidTokenError", (_stub.PyJWTError,), {})
        sys.modules["jwt"] = _stub

import server                      # noqa: E402  (有 __main__ 守卫，import 安全)
import supabase_store as store     # noqa: E402

ANNO_KEYS = ("cog_annos", "cog_expr")


class TestRecordKeysWhitelist(unittest.TestCase):
    """白名单本身"""

    def test_supabase_record_keys_contains_anno_keys(self):
        for k in ANNO_KEYS:
            self.assertIn(
                k, store.RECORD_KEYS,
                "supabase_store.RECORD_KEYS 缺 %s —— push_payload 会静默丢弃该数据" % k,
            )

    def test_empty_payload_covers_anno_keys(self):
        for k in ANNO_KEYS:
            self.assertIn(k, store.EMPTY_PAYLOAD)
            self.assertEqual(store.EMPTY_PAYLOAD[k], [])

    def test_record_keys_no_duplicates(self):
        self.assertEqual(len(store.RECORD_KEYS), len(set(store.RECORD_KEYS)))

    def test_server_default_pull_payload_has_anno_keys(self):
        """api_pull 无记录时返回的默认 payload 必须含这两个键，否则前端 j.payload.cog_annos 恒 undefined"""
        with open(os.path.join(ROOT, "server.py"), encoding="utf-8") as f:
            src = f.read()
        tree = ast.parse(src)
        found = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Dict):
                keys = [k.value for k in node.keys
                        if isinstance(k, ast.Constant) and isinstance(k.value, str)]
                if "times" in keys and "settings" in keys and "cog_reads" in keys:
                    found.append(keys)
        self.assertTrue(found, "找不到 api_pull 的默认 payload 字典字面量")
        for keys in found:
            for k in ANNO_KEYS:
                self.assertIn(k, keys, "默认 payload 字典缺 %s：%s" % (k, keys))

    def test_server_sqlite_fallback_merges_anno_keys(self):
        """SQLite 兜底分支的 inc 提取 + merge_records 三处都要覆盖"""
        with open(os.path.join(ROOT, "server.py"), encoding="utf-8") as f:
            src = f.read()
        for k in ANNO_KEYS:
            self.assertIn('inc_%s = inc.get("%s") or []' % (k, k), src,
                          "server.py 未从 inc 提取 %s" % k)
            self.assertIn('"%s": merge_records(cur.get("%s") or [], inc_%s)' % (k, k, k), src,
                          "server.py 的 new_payload 未合并 %s" % k)


class TestMergeRecords(unittest.TestCase):
    """真跑 server.merge_records（前后端语义必须一致）"""

    @staticmethod
    def anno(_id, updated, device="devA", text="", deleted=False):
        return {"id": _id, "updatedAt": updated, "deviceId": device,
                "text": text, "deleted": deleted, "bookId": "b1", "page": 1}

    def test_union_by_id(self):
        cur = [self.anno("a1", 100), self.anno("a2", 100)]
        inc = [self.anno("a3", 100)]
        out = server.merge_records(cur, inc)
        self.assertEqual(sorted(r["id"] for r in out), ["a1", "a2", "a3"])

    def test_lww_newer_wins(self):
        cur = [self.anno("a1", 100, text="old")]
        inc = [self.anno("a1", 200, text="new")]
        out = server.merge_records(cur, inc)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["text"], "new", "updatedAt 大者未获胜")

    def test_lww_older_loses(self):
        cur = [self.anno("a1", 300, text="keep")]
        inc = [self.anno("a1", 100, text="stale")]
        out = server.merge_records(cur, inc)
        self.assertEqual(out[0]["text"], "keep", "旧数据覆盖了新数据 —— 会吞掉本端批注")

    def test_tie_break_by_device_id(self):
        cur = [self.anno("a1", 100, device="devA", text="A")]
        inc = [self.anno("a1", 100, device="devB", text="B")]
        self.assertEqual(server.merge_records(cur, inc)[0]["text"], "B")
        # 反向：devA < devB，devB 应当守住
        cur2 = [self.anno("a1", 100, device="devB", text="B")]
        inc2 = [self.anno("a1", 100, device="devA", text="A")]
        self.assertEqual(server.merge_records(cur2, inc2)[0]["text"], "B",
                         "平局判定不对称 —— 两端会来回覆盖")

    def test_soft_delete_propagates(self):
        """软删是一次普通的 LWW 更新：删除必须能同步到另一端"""
        cur = [self.anno("a1", 100, deleted=False)]
        inc = [self.anno("a1", 200, deleted=True)]
        out = server.merge_records(cur, inc)
        self.assertTrue(out[0]["deleted"], "软删未跨端传播 —— 删掉的批注会复活")

    def test_deterministic_migrated_id_dedups(self):
        """两端各自迁移旧高亮，id 都是 mg_<旧id> → 合并后只剩一条"""
        cur = [self.anno("mg_r1", 100, device="devA")]
        inc = [self.anno("mg_r1", 100, device="devB")]
        out = server.merge_records(cur, inc)
        self.assertEqual(len(out), 1, "确定性 id 未能去重 —— 用户会看到两条一样的批注")

    def test_records_without_id_dropped(self):
        out = server.merge_records([{"updatedAt": 1}], [{"updatedAt": 2}])
        self.assertEqual(out, [])

    def test_none_inputs_safe(self):
        self.assertEqual(server.merge_records(None, None), [])
        self.assertEqual(len(server.merge_records(None, [self.anno("a1", 1)])), 1)

    def test_sorted_by_updated_at(self):
        out = server.merge_records(
            [self.anno("a1", 300), self.anno("a2", 100)], [self.anno("a3", 200)])
        self.assertEqual([r["id"] for r in out], ["a2", "a3", "a1"])

    def test_cog_annos_merge_end_to_end(self):
        """按主理人要求：cur/inc 都带 cog_annos，走真实合并路径"""
        cur = {"cog_annos": [self.anno("a1", 100, text="本端"), self.anno("a2", 100, text="只在本端")]}
        inc_cog_annos = [self.anno("a1", 500, text="远端更新"), self.anno("a3", 100, text="只在远端")]
        out = server.merge_records(cur.get("cog_annos") or [], inc_cog_annos)
        by_id = {r["id"]: r for r in out}
        self.assertEqual(sorted(by_id), ["a1", "a2", "a3"])
        self.assertEqual(by_id["a1"]["text"], "远端更新")
        self.assertEqual(by_id["a2"]["text"], "只在本端", "本端独有批注被合并丢了")
        self.assertEqual(by_id["a3"]["text"], "只在远端")


# ───────────── 假 supabase client：真跑 push_payload / pull_payload ─────────────

class _Resp:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, tbl, op):
        self.tbl, self.op, self.payload = tbl, op, None

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def update(self, payload):
        self.payload = payload
        return self

    def insert(self, payload):
        self.payload = payload
        return self

    def execute(self):
        if self.op == "select":
            return _Resp([{"payload": self.tbl.row["payload"],
                           "payload_version": self.tbl.row["payload_version"]}])
        if self.op == "update":
            self.tbl.row.update(self.payload)
            self.tbl.written.append(self.payload["payload"])
            return _Resp([{"uid": "u1"}])
        return _Resp([{"uid": "u1"}])


class _Table:
    def __init__(self, row):
        self.row, self.written = row, []

    def select(self, *a, **k):
        return _Query(self, "select").select(*a, **k)

    def update(self, payload):
        return _Query(self, "update").update(payload)

    def insert(self, payload):
        return _Query(self, "insert").insert(payload)


class _Client:
    def __init__(self, row):
        self.tbl = _Table(row)

    def table(self, _name):
        return self.tbl


class TestPushPayloadKeepsAnnos(unittest.TestCase):
    """最关键的一条：cog_annos 必须真的出现在写回 supabase 的 payload 里"""

    def setUp(self):
        self.row = {"payload": {k: [] for k in store.RECORD_KEYS}, "payload_version": 3}
        self.row["payload"]["settings"] = {}
        self.row["payload"]["cog_annos"] = [
            {"id": "a1", "updatedAt": 100, "deviceId": "devA", "text": "云端已有"}
        ]
        self.client = _Client(self.row)
        self._orig = store._svc
        store._svc = lambda: self.client

    def tearDown(self):
        store._svc = self._orig

    def test_push_payload_writes_cog_annos(self):
        inc = {"cog_annos": [{"id": "a2", "updatedAt": 200, "deviceId": "devB", "text": "新增"}]}
        store.push_payload("u1", inc)
        written = self.client.tbl.written[-1]
        self.assertIn("cog_annos", written,
                      "写回 supabase 的 payload 里没有 cog_annos —— 被 RECORD_KEYS 白名单吃掉了")
        ids = sorted(r["id"] for r in written["cog_annos"])
        self.assertEqual(ids, ["a1", "a2"], "云端已有批注与新推批注未正确合并：%s" % ids)

    def test_push_payload_writes_cog_expr(self):
        inc = {"cog_expr": [{"id": "e1", "updatedAt": 10, "deviceId": "devB"}]}
        store.push_payload("u1", inc)
        written = self.client.tbl.written[-1]
        self.assertIn("cog_expr", written, "cog_expr 被白名单吃掉")
        self.assertEqual([r["id"] for r in written["cog_expr"]], ["e1"])

    def test_push_payload_all_record_keys_present(self):
        store.push_payload("u1", {})
        written = self.client.tbl.written[-1]
        for k in store.RECORD_KEYS:
            self.assertIn(k, written, "写回 payload 缺键 %s" % k)
        self.assertIn("settings", written)

    def test_push_does_not_drop_existing_when_inc_missing_key(self):
        """客户端这次没推 cog_annos，云端已有的不能被清空"""
        store.push_payload("u1", {"times": []})
        written = self.client.tbl.written[-1]
        self.assertEqual([r["id"] for r in written["cog_annos"]], ["a1"],
                         "inc 未带 cog_annos 时，云端已有批注被清空了")

    def test_push_bumps_version_for_cas(self):
        store.push_payload("u1", {})
        self.assertEqual(self.row["payload_version"], 4, "CAS 版本号未递增")

    def test_pull_payload_returns_cog_annos(self):
        payload, _updated = store.pull_payload("u1")
        self.assertIn("cog_annos", payload)
        self.assertEqual([r["id"] for r in payload["cog_annos"]], ["a1"])


class TestFrontendBackendParity(unittest.TestCase):
    """前端 payload 键集合 与 后端 RECORD_KEYS 必须对齐（漏一个就是静默丢数据）"""

    def test_push_payload_keys_match_record_keys(self):
        with open(os.path.join(ROOT, "workbench.html"), encoding="utf-8") as f:
            html = f.read()
        i = html.index("const payload = { times, ideas, notes, diary")
        line = html[i:html.index("\n", i)]
        missing = []
        for k in store.RECORD_KEYS:
            # 前端写法既可能是 `cog_annos:cogAnnos` 也可能是简写 `times,`
            if (k + ":") not in line and not _bare_key(line, k):
                missing.append(k)
        self.assertEqual(missing, [],
                         "前端 pushSync payload 缺这些键（后端收不到 → 永远同步不上）：%s" % missing)


def _bare_key(line, k):
    import re
    return re.search(r"[{,]\s*%s\s*[,}]" % re.escape(k), line) is not None


if __name__ == "__main__":
    unittest.main(verbosity=2)
