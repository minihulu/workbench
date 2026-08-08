/**
 * 认知资产 + 英语助手 —— 行为回归测试（前端核心逻辑真跑）
 *
 * 策略（与 repo 既有 pdf-*.test.mjs 一致）：不重新实现被测逻辑，而是从 workbench.html
 * 「按标记抽取真实源码片段」放进带 DOM mock 的 vm 沙箱里真跑。断言的是线上代码本身，
 * 源码一改测试就会失效/报错。
 *
 * 覆盖本期（T01–T05）的用户侧逻辑：
 *  - 词典归一化 normalizeWord / 选区首词 firstSelectedWord
 *  - DictLoader.ensureLoaded（IndexedDB 缓存命中 / 懒加载注入 / 全失败抛错）
 *  - DictLoader.lookupWord（命中 / 未收录 / 归一化键 / 无词典）
 *  - TranslateService.callTranslate（成功 / 429 / 401 / 业务降级 / 网络异常 / 截断）
 *  - TR_FALLBACK_MSG 降级文案映射
 *  - showTrPop / showDictPop 浮层渲染（成功 / 失败 / 命中 / 未命中）
 *  - translateSelection 端到端（成功出译文 / 空文本早退）
 *  - Settings autoTranslate 默认 OFF 与开关读写
 */

import { test, describe, before, beforeEach } from 'node:test';
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
function extractLine(src, re, label) {
  const m = src.match(re);
  assert.ok(m, `抽取失败：找不到单行片段 ${label} → ${re}`);
  return m[0];
}

// 词典区块：_idb + normalizeWord + DictLoader + firstSelectedWord + TR_FALLBACK_MSG
const REGION_DICT = sliceBetween(HTML, 'const _idb = {', 'const TranslateService = {', 'dict');
// 翻译区块：TranslateService + translateSelection + showTrPop/closeTrPop + showDictPop/closeDictPop
const REGION_TRANSLATE = sliceBetween(HTML, 'const TranslateService = {', '/* ---- AI 调用', 'translate');
// 设置区块：$ / $$ / _mem / _canStore / LS / settings / Settings（不含 applyTheme 等副作用）
const REGION_SETTINGS = sliceBetween(HTML, 'const _mem = {}', 'const CATS = [', 'settings');
// 单行工具
const ESC_SRC = extractLine(HTML, /function esc\(s\)\{[^\n]*\n/, 'esc');
const APIHEADERS_SRC = extractLine(HTML, /function apiHeaders\(\)\{[^\n]*\n/, 'apiHeaders');

/* ────────────────────────── DOM / 全局 mock ────────────────────────── */
function makeStyle() {
  return { cssText: '', width: '', height: '', minHeight: '', position: '', left: '', top: '', fontSize: '', transform: '' };
}
function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: makeStyle(),
    children: [],
    parentNode: null,
    textContent: '',
    width: 0,
    offsetWidth: 10,
    clientWidth: 0,
    scrollHeight: 0,
    onclick: null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
    },
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => (el.children.length ? el.children.map((c) => `<${c.tagName.toLowerCase()}>`).join('') : el._html || ''),
    set: (v) => { el._html = String(v); el.children.length = 0; },
  });
  Object.defineProperty(el, 'childNodes', { get: () => el.children });
  return el;
}

// 可预设返回值的 IndexedDB mock（仅覆盖 _idb 用到的 get/put 路径）
function makeIDB(store) {
  // 注意：真实 IndexedDB 中 transaction.oncomplete 在事务（含其内所有 put）提交后触发，
  // 源码 _idb.set 正是 await 这个 tx.oncomplete 来 resolve。mock 必须触发 tx.oncomplete，
  // 而非 put 返回的独立 request 对象的 oncomplete（源码并未监听后者）。
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction() {
      const tx = {
        oncomplete: null,
        onerror: null,
        objectStore() {
          return {
            get(k) {
              const r = { onsuccess: null, result: store.get(k) };
              Promise.resolve().then(() => r.onsuccess && r.onsuccess());
              return r;
            },
            put(v, k) {
              store.set(k, v);
              Promise.resolve().then(() => { if (tx.oncomplete) tx.oncomplete(); });
              return { onerror: null };
            },
          };
        },
      };
      return tx;
    },
  };
  return {
    open() {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null };
      Promise.resolve().then(() => req.onsuccess && req.onsuccess());
      return req;
    },
  };
}

let SB; // 沙箱句柄，before() 中构建

function buildSandbox() {
  const idbStore = new Map();
  const localStorageMem = new Map();
  const localStorage = {
    getItem: (k) => (localStorageMem.has(k) ? localStorageMem.get(k) : null),
    setItem: (k, v) => localStorageMem.set(k, String(v)),
    removeItem: (k) => localStorageMem.delete(k),
  };

  const body = makeEl('body');
  const head = makeEl('head');
  const document = {
    body,
    head,
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  const windowObj = {
    innerHeight: 800,
    innerWidth: 1200,
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
    ECDICT: undefined,
  };

  let fetchMock = () => Promise.reject(new Error('no fetch mock set'));
  let apiToken = '';

  const sandbox = {
    console,
    window: windowObj,
    document,
    navigator: {},
    localStorage,
    indexedDB: makeIDB(idbStore),
    Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number, Boolean, parseFloat, parseInt, isNaN, RegExp,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    fetch: (...args) => fetchMock(...args),
    __setFetchMock: (fn) => { fetchMock = fn; },
    __setApiToken: (t) => { apiToken = t; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const prelude = `
    var apiToken = '';
    function toast(){}
  `;
  const epilogue = `
    globalThis.__api = {
      normalizeWord, firstSelectedWord, DictLoader, TranslateService, TR_FALLBACK_MSG,
      showTrPop, showDictPop, translateSelection,
      Settings, settings, LS,
      window: windowObjRef,
      setApiToken(v){ apiToken = v; },
    };
  `;
  // window/document 在 vm 内已是全局，无需再注入；这里仅把 window 透出给测试读取/写入 ECDICT
  const code = prelude + '\n' + ESC_SRC + '\n' + APIHEADERS_SRC + '\n' + REGION_DICT + '\n' + REGION_TRANSLATE + '\n' + REGION_SETTINGS + '\n' + epilogue
    .replace('windowObjRef', 'window');
  vm.runInContext(code, sandbox, { filename: 'cog-extracted.js' });

  return {
    api: sandbox.__api,
    sandbox,
    document,
    window: windowObj,
    head,
    body,
    idbStore,
    setFetchMock: (fn) => sandbox.__setFetchMock(fn),
    setApiToken: (t) => sandbox.__setApiToken(t),
  };
}

/* 构造 fetch 的响应桩 */
function makeFetchResponse(status, jsonBody) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => jsonBody,
  };
}

const FIXTURE_ECDICT = {
  hello: { phonetic: 'həˈləʊ', pos: 'int.', meaning: '你好；喂' },
  dont: { phonetic: "dəʊnt", pos: "aux.", meaning: "不要；不做" },
  abc: { phonetic: 'eɪ biː siː', pos: 'n.', meaning: '字母表' },
  reading: { phonetic: 'ˈriːdɪŋ', pos: 'n.', meaning: '阅读' },
};

before(() => { SB = buildSandbox(); });

/* ────────────────────────── 词典归一化 ────────────────────────── */
describe('normalizeWord 归一化', () => {
  test('小写 + 去标点/数字/空格，保留撇号', () => {
    assert.equal(SB.api.normalizeWord('Hello!'), 'hello');
    assert.equal(SB.api.normalizeWord('Don\'t'), 'dont');
    assert.equal(SB.api.normalizeWord('  Reading, 123'), 'reading');
    assert.equal(SB.api.normalizeWord('PDF-Reader'), 'pdfreader');
  });
  test('纯标点/数字返回空串', () => {
    assert.equal(SB.api.normalizeWord('!!!'), '');
    assert.equal(SB.api.normalizeWord('123'), '');
    assert.equal(SB.api.normalizeWord(''), '');
  });
});

describe('firstSelectedWord 选区首词', () => {
  test('取选区第一个英文单词', () => {
    assert.equal(SB.api.firstSelectedWord('The quick brown fox'), 'The');
    assert.equal(SB.api.firstSelectedWord('"reading" is fun'), 'reading');
    assert.equal(SB.api.firstSelectedWord('   word'), 'word');
  });
  test('无英文单词返回空串', () => {
    assert.equal(SB.api.firstSelectedWord(''), '');
    assert.equal(SB.api.firstSelectedWord('123 !@#'), '');
  });
});

/* ────────────────────────── DictLoader.lookupWord ────────────────────────── */
describe('DictLoader.lookupWord 查词', () => {
  before(() => { SB.window.ECDICT = FIXTURE_ECDICT; });

  test('命中返回 {word,phonetic,pos,meaning}', () => {
    const e = SB.api.DictLoader.lookupWord('Hello!');
    assert.ok(e, '应命中 hello');
    assert.equal(e.word, 'hello');
    assert.equal(e.phonetic, 'həˈləʊ');
    assert.equal(e.pos, 'int.');
    assert.equal(e.meaning, '你好；喂');
  });
  test('撇号与大小写归一化命中', () => {
    const e = SB.api.DictLoader.lookupWord("DON'T");
    assert.equal(e.word, 'dont');
    assert.equal(e.meaning, '不要；不做');
  });
  test('未收录词返回 null', () => {
    assert.equal(SB.api.DictLoader.lookupWord('zzzzz'), null);
  });
  test('无词典（window.ECDICT 未加载）返回 null', () => {
    const saved = SB.window.ECDICT;
    SB.window.ECDICT = undefined;
    assert.equal(SB.api.DictLoader.lookupWord('hello'), null);
    SB.window.ECDICT = saved;
  });
  test('空/纯标点输入返回 null', () => {
    assert.equal(SB.api.DictLoader.lookupWord(''), null);
    assert.equal(SB.api.DictLoader.lookupWord('!!!'), null);
  });
});

/* ────────────────────────── DictLoader.ensureLoaded ────────────────────────── */
describe('DictLoader.ensureLoaded 懒加载', () => {
  beforeEach(() => {
    // 重置模块级加载状态，避免用例间串扰（DictLoader._loaded 一但为 true 会直接短路）
    SB.api.DictLoader._loaded = false;
    SB.api.DictLoader._loading = null;
    SB.idbStore.clear();
    SB.window.ECDICT = undefined;
  });
  test('IndexedDB 缓存命中：直接采用缓存并标记已加载', async () => {
    SB.idbStore.set('ecdict', FIXTURE_ECDICT);
    const ok = await SB.api.DictLoader.ensureLoaded();
    assert.equal(ok, true);
    assert.equal(SB.window.ECDICT, FIXTURE_ECDICT);
  });

  test('无缓存：注入 <script> 加载并写回 IndexedDB 缓存', async () => {
    SB.idbStore.clear();
    SB.window.ECDICT = undefined;
    // ensureLoaded 在 await _idb.get 之后才会 append <script>，故在 appendChild 时自动触发 onload
    const origAppend = SB.document.head.appendChild;
    SB.document.head.appendChild = (s) => {
      const r = origAppend(s);
      SB.window.ECDICT = FIXTURE_ECDICT; // 模拟脚本加载完成填充 window.ECDICT
      if (s && s.onload) s.onload();
      return r;
    };
    const ok = await SB.api.DictLoader.ensureLoaded();
    SB.document.head.appendChild = origAppend;
    assert.equal(ok, true);
    assert.equal(SB.window.ECDICT, FIXTURE_ECDICT);
    assert.ok(SB.idbStore.has('ecdict'), '加载后应写回 IndexedDB 缓存');
  });

  test('脚本加载失败且无缓存：抛出 dict_load_failed', async () => {
    SB.idbStore.clear();
    SB.window.ECDICT = undefined;
    const origAppend = SB.document.head.appendChild;
    SB.document.head.appendChild = (s) => {
      const r = origAppend(s);
      if (s && s.onerror) s.onerror(); // 模拟脚本加载失败
      return r;
    };
    await assert.rejects(SB.api.DictLoader.ensureLoaded(), /dict_load_failed/);
    SB.document.head.appendChild = origAppend;
  });
});

/* ────────────────────────── TranslateService.callTranslate 合同 ────────────────────────── */
describe('TranslateService.callTranslate 翻译合同', () => {
  test('成功：200 + ok → {ok:true,translation,level}', async () => {
    let sentBody = null;
    SB.setApiToken('tok123');
    SB.setFetchMock(async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return makeFetchResponse(200, { ok: true, translation: '你好，世界', level: 'cet4/6' });
    });
    const res = await SB.api.TranslateService.callTranslate('hello world', 'cet4/6');
    assert.equal(res.ok, true);
    assert.equal(res.translation, '你好，世界');
    assert.equal(res.level, 'cet4/6');
    assert.equal(sentBody.task, 'translate');
    assert.equal(sentBody.level, 'cet4/6');
  });

  test('请求体文本被截断至 ≤2000 字符', async () => {
    let sentBody = null;
    SB.setApiToken('tok123');
    SB.setFetchMock(async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return makeFetchResponse(200, { ok: true, translation: 'x', level: 'cet4/6' });
    });
    const longText = 'a'.repeat(2500);
    await SB.api.TranslateService.callTranslate(longText, 'cet4/6');
    assert.ok(sentBody.text.length <= 2000, `text 长度应 ≤2000，实际 ${sentBody.text.length}`);
  });

  test('默认 level 为 cet4/6', async () => {
    let sentBody = null;
    SB.setApiToken('tok123');
    SB.setFetchMock(async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return makeFetchResponse(200, { ok: true, translation: 'x', level: 'cet4/6' });
    });
    await SB.api.TranslateService.callTranslate('hello');
    assert.equal(sentBody.level, 'cet4/6');
  });

  test('429 → reason: rate_limited', async () => {
    SB.setApiToken('tok123');
    SB.setFetchMock(async () => makeFetchResponse(429, {}));
    const res = await SB.api.TranslateService.callTranslate('hello');
    assert.equal(res.ok, false);
    assert.equal(res.fallback, true);
    assert.equal(res.reason, 'rate_limited');
  });

  test('401 → reason: upstream_error', async () => {
    SB.setApiToken('tok123');
    SB.setFetchMock(async () => makeFetchResponse(401, {}));
    const res = await SB.api.TranslateService.callTranslate('hello');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'upstream_error');
  });

  test('200 但业务降级 → 透传 reason', async () => {
    SB.setApiToken('tok123');
    SB.setFetchMock(async () => makeFetchResponse(200, { ok: false, reason: 'llm_not_configured' }));
    const res = await SB.api.TranslateService.callTranslate('hello');
    assert.equal(res.ok, false);
    assert.equal(res.fallback, true);
    assert.equal(res.reason, 'llm_not_configured');
  });

  test('网络异常 → reason: upstream_error', async () => {
    SB.setApiToken('tok123');
    SB.setFetchMock(async () => { throw new Error('net down'); });
    const res = await SB.api.TranslateService.callTranslate('hello');
    assert.equal(res.ok, false);
    assert.equal(res.fallback, true);
    assert.equal(res.reason, 'upstream_error');
  });
});

/* ────────────────────────── TR_FALLBACK_MSG 降级文案 ────────────────────────── */
describe('TR_FALLBACK_MSG 降级文案', () => {
  test('每种 reason 都有中文提示', () => {
    const m = SB.api.TR_FALLBACK_MSG;
    for (const reason of ['rate_limited', 'llm_not_configured', 'upstream_error', 'timeout', 'parse_failed', 'bad_request']) {
      assert.ok(typeof m[reason] === 'string' && m[reason].length > 0, `缺少 ${reason} 的降级文案`);
    }
  });
  test('未知 reason 走兜底（showTrPop 处理）', () => {
    assert.equal(SB.api.TR_FALLBACK_MSG['unknown'], undefined);
  });
});

/* ────────────────────────── showTrPop / showDictPop 浮层渲染 ────────────────────────── */
describe('showTrPop 翻译浮层', () => {
  function lastPop() { return SB.document.body.children[SB.document.body.children.length - 1]; }
  const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 20, top: 20, width: 0, height: 0 }) };

  test('成功：渲染译文 + 等级', () => {
    SB.api.showTrPop(anchor, { ok: true, translation: '你好，世界', level: 'cet4/6' }, 'hello world');
    const pop = lastPop();
    assert.ok(pop.className.includes('tr-pop'));
    assert.ok(pop.innerHTML.includes('你好，世界'));
    assert.ok(pop.innerHTML.includes('cet4/6'));
    assert.ok(/^\d+(\.\d+)?px$/.test(pop.style.top), 'top 应为 px 定位');
  });

  test('失败：渲染降级提示（来自 TR_FALLBACK_MSG）', () => {
    SB.api.showTrPop(anchor, { ok: false, fallback: true, reason: 'rate_limited' }, 'hello');
    const pop = lastPop();
    assert.ok(pop.innerHTML.includes('请求过于频繁，请稍后再试'));
  });

  test('未知 reason：渲染兜底文案', () => {
    SB.api.showTrPop(anchor, { ok: false, fallback: true, reason: 'unknown' }, 'hello');
    const pop = lastPop();
    assert.ok(pop.innerHTML.includes('翻译暂不可用'));
  });
});

describe('showDictPop 查词浮层', () => {
  function lastPop() { return SB.document.body.children[SB.document.body.children.length - 1]; }
  const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 20, top: 20, width: 0, height: 0 }) };

  test('命中：渲染音标/词性/释义', () => {
    SB.window.ECDICT = FIXTURE_ECDICT;
    SB.api.showDictPop(anchor, SB.api.DictLoader.lookupWord('hello'), 'hello');
    const pop = lastPop();
    assert.ok(pop.className.includes('dict-pop'));
    assert.ok(pop.innerHTML.includes('hello'));
    assert.ok(pop.innerHTML.includes('həˈləʊ'));
    assert.ok(pop.innerHTML.includes('你好；喂'));
  });

  test('未命中：渲染「本地词典未收录该词」', () => {
    SB.api.showDictPop(anchor, null, 'zzzzz');
    const pop = lastPop();
    assert.ok(pop.innerHTML.includes('本地词典未收录该词'));
  });
});

/* ────────────────────────── translateSelection 端到端 ────────────────────────── */
describe('translateSelection 端到端', () => {
  test('成功：调用 callTranslate 并弹出译文浮层', async () => {
    SB.setApiToken('tok123');
    SB.setFetchMock(async () => makeFetchResponse(200, { ok: true, translation: '你好', level: 'cet4/6' }));
    const before = SB.document.body.children.length;
    const anchor = { getBoundingClientRect: () => ({ left: 1, bottom: 2, top: 2, width: 0, height: 0 }) };
    await SB.api.translateSelection('hello world', anchor);
    assert.equal(SB.document.body.children.length, before + 1, '应新增一个翻译浮层');
    const pop = SB.document.body.children[SB.document.body.children.length - 1];
    assert.ok(pop.innerHTML.includes('你好'));
  });

  test('空文本：直接早退，不弹出浮层', async () => {
    const before = SB.document.body.children.length;
    await SB.api.translateSelection('   ', { getBoundingClientRect: () => ({}) });
    assert.equal(SB.document.body.children.length, before, '空文本不应弹出浮层');
  });
});

/* ────────────────────────── Settings.autoTranslate ────────────────────────── */
describe('Settings.autoTranslate 开关', () => {
  test('默认 OFF', () => {
    assert.equal(SB.api.Settings.get('autoTranslate'), false);
  });
  test('set 开启后可读且持久化到 LS', () => {
    SB.api.Settings.set('autoTranslate', true);
    assert.equal(SB.api.Settings.get('autoTranslate'), true);
    assert.equal(SB.api.LS.get('wb_settings').autoTranslate, true);
  });
  test('set 关闭', () => {
    SB.api.Settings.set('autoTranslate', false);
    assert.equal(SB.api.Settings.get('autoTranslate'), false);
  });
});
