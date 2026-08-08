/**
 * 聚焦回归：首字母分片懒加载（ecdictShardKey / ensureShard / lookupWord）
 *
 * 策略（与 test_cog_english_behavior.test.mjs 一致）：不重新实现被测逻辑，
 * 而是从 workbench.html「按标记抽取真实源码片段」放进带 DOM mock 的 vm 沙箱里真跑。
 * 断言的是线上代码本身——源码一改测试就会失效/报错。
 *
 * 覆盖：
 *  - ecdictShardKey：首字母分片键（含 'hood/-ability/123abc 取首字母，!!! 取 #）
 *  - ensureShard：注入 <script src="vendor/ecdict/<letter>.js">；onload 后记入 loadedShards；同源不重复注入
 *  - ensureShard('#')：# 类分片缺失时静默 resolve（不阻断查词）
 *  - lookupWord（异步）：ensureShard 注入分片后，window.ECDICT 命中真实词条
 */

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const HTML = fs.readFileSync(WORKBENCH, 'utf8');

/* ────────────────────────── 源码抽取 ────────────────────────── */
function sliceBetween(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `抽取失败：找不到起始标记 ${label} → ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.notEqual(b, -1, `抽取失败：找不到结束标记 ${label} → ${endMarker}`);
  return src.slice(a, b);
}
function extractBlock(src, re, label) {
  const m = src.match(re);
  assert.ok(m, `抽取失败：找不到片段 ${label} → ${re}`);
  return m[0];
}

const NORMALIZE_SRC = extractBlock(HTML, /function normalizeWord\(w\)\{[\s\S]*?\n\}/, 'normalizeWord');
const SHARD_HELPERS = sliceBetween(
  HTML,
  '/* ===ECDICT_SHARD_HELPERS_START=== */',
  '/* ===ECDICT_SHARD_HELPERS_END=== */',
  'shardHelpers'
);
// DictLoader 对象（含异步 lookupWord）：从 `const DictLoader = {` 到紧随其后的选区注释前
const DICT_LOADER = sliceBetween(HTML, 'const DictLoader = {', '/* 取选区里第一个英文单词', 'dictLoader');

/* ────────────────────────── DOM / 全局 mock ────────────────────────── */
let SB; // 沙箱句柄

function buildShardSandbox() {
  const windowObj = { ECDICT: undefined, innerHeight: 800, innerWidth: 1200 };

  function makeScript() {
    return { tagName: 'SCRIPT', src: '', onload: null, onerror: null };
  }
  const head = {
    children: [],
    appendChild(s) {
      head.children.push(s);
      return s;
    },
  };
  const document = {
    createElement: (tag) => (String(tag).toLowerCase() === 'script' ? makeScript() : { tagName: String(tag).toUpperCase() }),
    head,
    body: { children: [], appendChild() {} },
    querySelector: () => null,
  };

  const sandbox = {
    console,
    window: windowObj,
    document,
    Math, JSON, Set, Map, Object, Array, Promise, Error, String, RegExp,
    setTimeout: (fn) => { fn(); return 0; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const code =
    NORMALIZE_SRC + '\n' +
    SHARD_HELPERS + '\n' +
    DICT_LOADER + '\n' +
    'globalThis.__api = { normalizeWord, ecdictShardKey, ensureShard, loadedShards, DictLoader, window };';
  vm.runInContext(code, sandbox, { filename: 'shard-extracted.js' });

  const rawAppend = head.appendChild; // 捕获 makeEl 原始 appendChild（不被后续重写影响）
  const autoAppend = (s) => {
    const r = rawAppend(s);
    if (s && typeof s.onload === 'function') s.onload();
    return r;
  };

  return {
    api: sandbox.__api,
    window: windowObj,
    head,
    document,
    rawAppend, // 原始 appendChild（不触发 onload）
    // 自动触发 onload 的 appendChild（模拟浏览器加载完成），走闭包调用 rawAppend 避免自递归
    autoAppend,
  };
}

before(() => { SB = buildShardSandbox(); });

beforeEach(() => {
  // 重置跨测试共享状态
  SB.api.loadedShards.clear();
  SB.head.children.length = 0;
  SB.window.ECDICT = undefined;
  SB.document.head.appendChild = SB.rawAppend;
});

/* ────────────────────────── ecdictShardKey ────────────────────────── */
describe('ecdictShardKey 首字母分片键', () => {
  test("ecdictShardKey('Apple')==='a'", () => assert.equal(SB.api.ecdictShardKey('Apple'), 'a'));
  test("ecdictShardKey(\"'hood\")==='h'", () => assert.equal(SB.api.ecdictShardKey("'hood"), 'h'));
  test("ecdictShardKey('-ability')==='a'", () => assert.equal(SB.api.ecdictShardKey('-ability'), 'a'));
  test("ecdictShardKey('123abc')==='a'", () => assert.equal(SB.api.ecdictShardKey('123abc'), 'a'));
  test("ecdictShardKey('!!!')==='#'", () => assert.equal(SB.api.ecdictShardKey('!!!'), '#'));
});

/* ────────────────────────── ensureShard 注入 ────────────────────────── */
describe('ensureShard 懒加载分片', () => {
  test('ensureShard("a") 注入 vendor/ecdict/a.js，onload 后记入 loadedShards', async () => {
    let injected = null;
    SB.document.head.appendChild = (s) => {
      injected = s;
      const r = SB.rawAppend(s);
      if (s && s.onload) s.onload();
      return r;
    };
    await SB.api.ensureShard('a');
    assert.ok(injected, '应注入一个 script');
    assert.equal(injected.src, 'vendor/ecdict/a.js', '脚本路径应为 vendor/ecdict/a.js');
    assert.ok(SB.api.loadedShards.has('a'), 'loadedShards 应含 a');
    assert.equal(SB.head.children.length, 1, '只应注入一次');
  });

  test('ensureShard 同源重复调用不重复注入', async () => {
    let count = 0;
    SB.document.head.appendChild = (s) => {
      count += 1;
      const r = SB.rawAppend(s);
      if (s && s.onload) s.onload();
      return r;
    };
    await SB.api.ensureShard('b');
    await SB.api.ensureShard('b');
    assert.equal(count, 1, '重复 ensureShard 不应再次注入');
    assert.ok(SB.api.loadedShards.has('b'));
  });

  test('ensureShard("#") 分片缺失时静默 resolve（不阻断查词）', async () => {
    SB.document.head.appendChild = (s) => {
      const r = SB.rawAppend(s);
      // 模拟 # 类分片（_.js）不存在：触发 onerror
      if (s && s.onerror) s.onerror(new Error('404'));
      return r;
    };
    // 不应抛错
    await SB.api.ensureShard('#');
    assert.ok(SB.api.loadedShards.has('#'), '缺失的 # 分片也应记入 loadedShards，避免重复尝试');
  });
});

/* ────────────────────────── lookupWord（异步）────────────────────────── */
describe('DictLoader.lookupWord 异步命中分片', () => {
  beforeEach(() => {
    // lookupWord 路径需要分片脚本加载后触发 onload
    SB.document.head.appendChild = SB.autoAppend;
  });

  test('模拟注入含 demo 的分片后，await lookupWord("demo") 返回该词条', async () => {
    SB.window.ECDICT = SB.window.ECDICT || {};
    const FIXTURE = { demo: { phonetic: 'd', pos: 'n.', meaning: '示例' } };
    // 拦截分片注入：把夹具词条合并进 window.ECDICT（模拟分片 IIFE 的效果）
    SB.document.head.appendChild = (s) => {
      const r = SB.rawAppend(s);
      if (s && typeof s.src === 'string' && s.src.includes('ecdict/')) {
        const base = SB.window.ECDICT || {};
        Object.assign(base, FIXTURE);
        SB.window.ECDICT = base;
      }
      if (s && s.onload) s.onload();
      return r;
    };

    const entry = await SB.api.DictLoader.lookupWord('demo');
    assert.ok(entry, '应命中 demo');
    assert.equal(entry.word, 'demo');
    assert.equal(entry.phonetic, 'd');
    assert.equal(entry.pos, 'n.');
    assert.equal(entry.meaning, '示例');
    // 验证确实注入了 d 分片（demo 首字母 d）
    assert.ok(SB.api.loadedShards.has('d'), '应已加载 d 分片');
  });

  test('未收录词返回 null（不抛错）', async () => {
    // 分片注入但不含该词
    SB.document.head.appendChild = (s) => {
      const r = SB.rawAppend(s);
      if (s && s.onload) s.onload();
      return r;
    };
    assert.equal(await SB.api.DictLoader.lookupWord('zzzqqqzzz'), null);
  });

  test('空/纯标点输入返回 null', async () => {
    assert.equal(await SB.api.DictLoader.lookupWord(''), null);
    assert.equal(await SB.api.DictLoader.lookupWord('!!!'), null);
  });
});
