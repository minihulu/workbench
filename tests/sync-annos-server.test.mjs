/**
 * 桥接：把 tests/test_sync_annos.py（服务端同步白名单）纳入 `npm test`。
 *
 * 为什么必须进 CI：supabase_store.push_payload 用
 *   {k: merge_records(...) for k in RECORD_KEYS}
 * 组装写回数据，漏一个 key 就是**静默丢数据**——不报错、不告警，
 * 只表现为「换台设备批注就没了」。这类 bug 必须由自动化守住。
 *
 * 环境无 python 时 skip（而不是假绿），并在输出里明确提示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tests', 'test_sync_annos.py');

function findPython() {
  for (const c of ['python', 'python3', 'py']) {
    const r = spawnSync(c, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '3') return c;
  }
  return null;
}

test('服务端同步白名单（cog_annos / cog_expr）—— python unittest', (t) => {
  const py = findPython();
  if (!py) {
    t.skip('未找到 python3，跳过服务端白名单测试（请手动跑 python tests/test_sync_annos.py）');
    return;
  }
  const r = spawnSync(py, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.equal(r.status, 0, `服务端白名单测试失败：\n${out}`);
  assert.match(out, /Ran \d+ tests/, `python 测试未正常执行：\n${out}`);
  assert.match(out, /\nOK\b/, `python 测试未全绿：\n${out}`);
});
