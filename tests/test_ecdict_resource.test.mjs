/**
 * 聚焦回归：本地词典资源 vendor/ecdict.min.js（生产真实加载路径）
 *
 * 背景：行为测试（test_cog_english_behavior.test.mjs）直接注入 window.ECDICT 桩，
 * 即便 vendor/ecdict.min.js 缺失/损坏也会通过——这是真实的回归盲区。本文件补齐：
 *  - 资源存在且是合法 JS；
 *  - 真实加载后 window.ECDICT 为非空对象；
 *  - 所有键符合「小写纯字母」约定（与前端 lookupWord 归一化一致）；
 *  - 词条具备 {phonetic,pos,meaning} 形态；
 *  - 用 workbench.html 中**真实**的 normalizeWord，验证真实词典键可被命中
 *    （含标点/大小写变体），证明「资源 + 归一化」端到端可用。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICT_PATH = path.join(ROOT, 'vendor/ecdict.min.js');
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');

let ECDICT = null; // 真实加载后的 window.ECDICT
let normalizeWord = null; // 从 workbench.html 抽取的真实实现

before(async () => {
  const src = fs.readFileSync(DICT_PATH, 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'ecdict.min.js' });
  ECDICT = sandbox.window.ECDICT;

  const html = fs.readFileSync(WORKBENCH, 'utf8');
  const m = html.match(/function normalizeWord\(w\)\{[\s\S]*?\n\}/);
  assert.ok(m, '无法从 workbench.html 抽取 normalizeWord 真实实现');
  // 在隔离上下文里求该函数定义
  const fnCtx = {};
  vm.createContext(fnCtx);
  vm.runInContext(m[0] + '\nglobalThis.__nw = normalizeWord;', fnCtx, { filename: 'normalizeWord.js' });
  normalizeWord = fnCtx.__nw;
});

describe('vendor/ecdict.min.js 资源有效性', () => {
  test('文件存在且加载后 window.ECDICT 为非空对象', () => {
    assert.ok(ECDICT && typeof ECDICT === 'object', 'window.ECDICT 应存在且为对象');
    assert.ok(Object.keys(ECDICT).length > 0, '词典不应为空');
  });

  test('所有键符合「小写纯字母」约定（与 lookupWord 归一化一致）', () => {
    const keys = Object.keys(ECDICT);
    const bad = keys.filter((k) => !/^[a-z]+$/.test(k));
    assert.equal(bad.length, 0, `存在不符合约定的键：${bad.slice(0, 5).join(', ')}`);
  });

  test('词条具备 {phonetic,pos,meaning} 形态', () => {
    const e = ECDICT[Object.keys(ECDICT)[0]];
    for (const f of ['phonetic', 'pos', 'meaning']) {
      assert.ok(f in e, `词条缺少字段 ${f}`);
    }
  });
});

describe('真实词典键 × 真实 normalizeWord 命中', () => {
  test('原生小写键可被命中', () => {
    const keys = Object.keys(ECDICT);
    const k = keys[0];
    assert.equal(normalizeWord(k), k, `normalizeWord(${k}) 应等于原始键`);
    assert.ok(ECDICT[normalizeWord(k)], `真实词典应命中 ${k}`);
  });

  test('标点/大小写变体归一化后命中（端到端可用）', () => {
    // 取一个真实存在的常见词，构造带标点/大小写的输入
    const base = ECDICT['the'] ? 'the' : Object.keys(ECDICT)[0];
    const variants = [`${base}.`, ` ${base.toUpperCase()}!`, `"${base}"`, `${base},123`];
    for (const v of variants) {
      const n = normalizeWord(v);
      assert.equal(n, base, `normalizeWord(${JSON.stringify(v)}) 应归一化为 ${base}，实际 ${n}`);
      assert.ok(ECDICT[n], `归一化后 ${n} 应在真实词典中可命中`);
    }
  });

  test('归一化后不在词典的词返回 null（查词未命中语义一致）', () => {
    const n = normalizeWord('zzzqqqzzz');
    // 仅当该键确实不存在时，lookupWord 路径会返回 null；这里只验证归一化产物不直接命中
    assert.equal(ECDICT[n] || null, null, '随机无意义词不应命中真实词典');
  });
});
