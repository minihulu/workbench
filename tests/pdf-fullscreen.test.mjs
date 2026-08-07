/**
 * PDF.js 阅读器「⛶ 全屏自适应阅读」功能 —— 独立验证测试
 *
 * 背景：工程师在 workbench.html 新增全屏阅读功能（原生 Fullscreen API + iOS Safari 的
 * CSS 沉浸式兜底）。仅改动 workbench.html / index.html（两者字节级一致），数据层/server.py 未动。
 *
 * 策略（沿用 pdf-default-mode.test.mjs / pdf-render.test.mjs 范式）：不重新实现被测逻辑，
 * 而是从 workbench.html 里「按标记抽取真实源码片段」，放进带 mini-DOM + document + 存储 mock
 * 的 vm 沙箱里真跑，断言线上代码本身。
 *
 * 覆盖（对应交付要求的 8 个用例）：
 *   A 按钮存在：渲染工具栏后 #pdfFullBtn 存在且初始文案为 ⛶ 全屏
 *   B 桌面原生全屏进入：requestFullscreen 被调用，fullscreenchange 后按钮变 🔳 退出，触发 pdfRelayout
 *   C ESC/原生退出：原生全屏中再点按钮 → document.exitFullscreen() 被调用；fullscreenchange 后按钮恢复 ⛶ 全屏
 *   D iOS 兜底（无原生 API）：加 .immersive 类、fullscreenElement 仍 null、按钮变 🔳 退出（不走原生、不报错）
 *   E 兜底退出：immersive 状态下再点按钮 → 移除 .immersive 类、按钮恢复 ⛶ 全屏
 *   F 原生失败兜底：requestFullscreen 返回 rejected promise → .catch 降级加 .immersive（不抛错）
 *   G CSS 校验：workbench.html 含 .immersive / :fullscreen 规则与手机端 @media(max-width:760px) .pdf-toc.show 浮层规则
 *   H 镜像一致：workbench.html 与 index.html 字节级一致
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const INDEX = path.join(ROOT, 'index.html');
const HTML = fs.readFileSync(WORKBENCH, 'utf8');

/* ────────────────────────── 源码抽取 ────────────────────────── */

function sliceBetween(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `抽取失败：找不到起始标记 ${label} → ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.notEqual(b, -1, `抽取失败：找不到结束标记 ${label} → ${endMarker}`);
  return src.slice(a, b);
}

// 全屏函数区块：从全局声明 `let _pdfFullCtx = null;` 到「自适应」章节注释之前，
// 涵盖 syncPdfFullBtn / togglePdfFullscreen / ensurePdfFullscreenListeners 三个函数与两个全局守卫变量。
const REGION_FULLSCREEN = sliceBetween(
  HTML,
  'let _pdfFullCtx = null;',
  '/* === 自适应：阅读容器可用宽度',
  'fullscreen'
);

// 阅读器骨架模板（工具栏按钮文案都在这里），用于静态校验 #pdfFullBtn 的存在与初始文案。
const REGION_SHELL = (() => {
  const head = 'box.innerHTML = `';
  const a = HTML.indexOf(head + '<div class="pdf-reader">');
  assert.notEqual(a, -1, '抽取失败：找不到阅读器骨架模板');
  const s = a + head.length;
  const e = HTML.indexOf('`', s);
  assert.notEqual(e, -1, '抽取失败：骨架模板未闭合');
  return HTML.slice(s, e);
})();

/* ────────────────────────── DOM mock ────────────────────────── */

function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: { cssText: '', width: '', height: '', minHeight: '' },
    children: [],
    parentNode: null,
    textContent: '',
    width: 0, height: 0,
    clientWidth: 0, clientHeight: 0, scrollHeight: 0, offsetWidth: 0, offsetHeight: 0,
    onclick: null,
    onscroll: null,
    _html: '',
    getContext: () => ({ drawImage() {}, clearRect() {} }),
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    scrollIntoView() { el.__scrolledIntoView = (el.__scrolledIntoView || 0) + 1; },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: el.clientWidth, height: el.clientHeight }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
    },
    __classes: classes,
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => (el.children.length ? el.children.map((c) => `<${c.tagName.toLowerCase()}>`).join('') : el._html),
    set: (v) => { el._html = String(v); el.children.length = 0; },
  });
  return el;
}

function makeDoc(numPages = 20) { return { __tag: 'doc', numPages, getPage: async () => ({}) }; }
function makeContainer(env, contentWidth = 1000) {
  const el = env.makeEl('div');
  el.clientWidth = contentWidth + 2;
  el.clientHeight = 800;
  el.scrollHeight = 99999;
  return el;
}

/**
 * 构建全屏行为沙箱：注入 mock 全局 + 真实全屏源码区块，供直接调用
 * togglePdfFullscreen / syncPdfFullBtn / ensurePdfFullscreenListeners。
 *
 * 关键 mock：
 *  - $ 返回 #pdfFullBtn；document.querySelector('.pdf-reader') 返回 reader，使 syncPdfFullBtn 一致
 *  - document.fullscreenElement / exitFullscreen 可写可 spy
 *  - document.addEventListener 记录 fullscreenchange / webkitfullscreenchange 监听，供手动派发
 *  - requestAnimationFrame 同步执行回调用并计数；pdfRelayout 用 spy 计数
 */
function loadFsSandbox() {
  const calls = {
    relayout: 0,          // pdfRelayout 调用次数
    raf: 0,               // requestAnimationFrame 调用次数
    exitFullscreen: 0,    // document.exitFullscreen 调用次数
    fsListeners: {},      // type -> [fn]
  };

  const reader = makeEl('div');     // 模拟 .pdf-reader
  const fullBtn = makeEl('button');
  fullBtn.textContent = '⛶ 全屏';   // 初始文案

  const els = { '#pdfFullBtn': fullBtn };

  const document = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    exitFullscreen: null,          // 由测试按场景注入 spy
    webkitExitFullscreen: null,
    msExitFullscreen: null,
    body: makeEl('body'),
    createElement: (t) => makeEl(t),
    querySelector: (sel) => (sel === '.pdf-reader' ? reader : null),
    querySelectorAll: () => [],
    addEventListener(type, fn) { (calls.fsListeners[type] ||= []).push(fn); },
    removeEventListener() {},
  };

  const windowObj = {
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  };

  const sandbox = {
    console,
    window: windowObj,
    document,
    $: (sel) => els[sel] || null,
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px' }),
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    requestAnimationFrame: (fn) => { calls.raf++; fn(); return calls.raf; },
    Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number, parseFloat, parseInt, isNaN,
    __calls: calls,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const prelude = `
    function pdfRelayout(doc, total, pagesEl, b){ __calls.relayout++; }
  `;

  const epilogue = `
    globalThis.__api = {
      togglePdfFullscreen, syncPdfFullBtn, ensurePdfFullscreenListeners,
      getCtx: () => _pdfFullCtx,
      setCtx: (o) => { _pdfFullCtx = o; },
    };
  `;

  vm.runInContext(
    [prelude, REGION_FULLSCREEN, epilogue].join('\n'),
    sandbox,
    { filename: 'workbench-fullscreen.js' }
  );

  const api = sandbox.__api;
  return { api, calls, els, reader, fullBtn, document, window: windowObj, makeEl };
}

/** 手动派发 fullscreenchange 监听（模拟浏览器进入/退出原生全屏后的事件） */
function fireFsChange(env) {
  const ls = env.calls.fsListeners['fullscreenchange'] || [];
  ls.forEach((fn) => fn());
}

/* ══════════════════════ A. 按钮存在 + 初始文案 ══════════════════════ */

describe('A. 全屏按钮存在且初始文案', () => {
  test('A1 工具栏含 #pdfFullBtn，且初始文案为 ⛶ 全屏', () => {
    assert.match(REGION_SHELL, /id="pdfFullBtn"/, '骨架模板缺少 #pdfFullBtn 按钮');
    assert.match(REGION_SHELL, />⛶ 全屏<\/button>/, '全屏按钮初始文案应为 ⛶ 全屏');
    // 位于 #pdfTocToggle 之后（顺序合理）
    const tocIdx = REGION_SHELL.indexOf('id="pdfTocToggle"');
    const fullIdx = REGION_SHELL.indexOf('id="pdfFullBtn"');
    assert.ok(tocIdx >= 0 && fullIdx > tocIdx, '全屏按钮应位于目录按钮之后');
  });
});

/* ══════════════════════ B. 桌面原生全屏进入 ══════════════════════ */

describe('B. 桌面原生全屏进入', () => {
  test('B1 点按钮 → requestFullscreen 被调用；fullscreenchange 后按钮变 🔳 退出并触发 pdfRelayout', () => {
    const env = loadFsSandbox();
    const { reader, fullBtn, document, calls, api } = env;
    let reqCount = 0;
    reader.requestFullscreen = () => { reqCount++; document.fullscreenElement = reader; return Promise.resolve(); };

    api.ensurePdfFullscreenListeners();
    api.setCtx({ reader, doc: makeDoc(10), total: 10, pagesEl: makeContainer(env), b: { id: 'bk' } });

    // 模拟点击全屏按钮
    api.togglePdfFullscreen(reader, makeDoc(10), 10, makeContainer(env), { id: 'bk' });

    assert.equal(reqCount, 1, '应调用一次 reader.requestFullscreen');
    // 原生进入依赖浏览器派发 fullscreenchange → 监听里 syncPdfFullBtn + 按新宽度重排
    assert.equal(calls.relayout, 0, '进入后、fullscreenchange 前不应提前重排');
    fireFsChange(env);
    assert.equal(fullBtn.textContent, '🔳 退出', '全屏中应显示 🔳 退出');
    assert.equal(calls.relayout, 1, 'fullscreenchange 后应触发一次 pdfRelayout 按新宽度重排');
    assert.equal(calls.raf, 1, '重排应通过 requestAnimationFrame 调度');
  });
});

/* ══════════════════════ C. ESC / 原生退出 ══════════════════════ */

describe('C. ESC / 原生退出', () => {
  test('C1 原生全屏中再点按钮 → 调 document.exitFullscreen()；fullscreenchange 后按钮恢复 ⛶ 全屏', () => {
    const env = loadFsSandbox();
    const { reader, fullBtn, document, calls, api } = env;
    document.fullscreenElement = reader;   // 模拟已进入原生全屏
    document.exitFullscreen = () => { calls.exitFullscreen++; document.fullscreenElement = null; };
    api.ensurePdfFullscreenListeners();
    api.setCtx({ reader, doc: makeDoc(10), total: 10, pagesEl: makeContainer(env), b: { id: 'bk' } });

    // 模拟在原生全屏中点击按钮
    api.togglePdfFullscreen(reader, makeDoc(10), 10, makeContainer(env), { id: 'bk' });

    assert.equal(calls.exitFullscreen, 1, '应调用 document.exitFullscreen 退出原生全屏');
    assert.equal(document.fullscreenElement, null, 'exitFullscreen 后 fullscreenElement 应为 null（模拟浏览器行为）');
    assert.equal(fullBtn.textContent, '⛶ 全屏', '点击退出后按钮文案不应立即变（由 fullscreenchange 同步）');
    fireFsChange(env);
    assert.equal(fullBtn.textContent, '⛶ 全屏', '退出后按钮应恢复 ⛶ 全屏');
    assert.equal(calls.relayout, 1, '退出后也应触发一次 pdfRelayout 按新宽度重排');
  });
});

/* ══════════════════════ D. iOS 兜底（无原生 API） ══════════════════════ */

describe('D. iOS Safari 兜底（无原生全屏 API）', () => {
  test('D1 无 requestFullscreen/webkit/ms → 加 .immersive、fullscreenElement 仍 null、按钮变 🔳 退出（不报错）', () => {
    const env = loadFsSandbox();
    const { reader, fullBtn, document, calls, api } = env;
    // 删除所有原生全屏 API，模拟 iOS Safari 仅 video 支持 requestFullscreen 的场景
    reader.requestFullscreen = undefined;
    reader.webkitRequestFullscreen = undefined;
    reader.msRequestFullscreen = undefined;

    assert.doesNotThrow(
      () => api.togglePdfFullscreen(reader, makeDoc(10), 10, makeContainer(env), { id: 'bk' }),
      'iOS 兜底不应抛出异常'
    );
    assert.ok(reader.classList.contains('immersive'), 'iOS 兜底应给 reader 加 .immersive 类（CSS 铺满）');
    assert.equal(document.fullscreenElement, null, 'iOS 兜底不应走原生全屏（fullscreenElement 须为 null）');
    assert.equal(fullBtn.textContent, '🔳 退出', 'iOS 兜底下按钮应显示 🔳 退出');
    assert.equal(calls.relayout, 1, 'iOS 兜底进入后应触发一次 pdfRelayout 按新宽度重排');
  });
});

/* ══════════════════════ E. 兜底退出 ══════════════════════ */

describe('E. 兜底（CSS 沉浸式）退出', () => {
  test('E1 已含 .immersive 状态下点按钮 → 移除 .immersive 类、按钮恢复 ⛶ 全屏', () => {
    const env = loadFsSandbox();
    const { reader, fullBtn, document, calls, api } = env;
    reader.classList.add('immersive');
    document.fullscreenElement = null;

    api.togglePdfFullscreen(reader, makeDoc(10), 10, makeContainer(env), { id: 'bk' });

    assert.ok(!reader.classList.contains('immersive'), '退出后应移除 .immersive 类');
    assert.equal(fullBtn.textContent, '⛶ 全屏', '退出兜底后应恢复 ⛶ 全屏文案');
    assert.equal(calls.relayout, 1, '退出兜底后应触发一次 pdfRelayout 按新宽度重排');
  });
});

/* ══════════════════════ F. 原生失败兜底 ══════════════════════ */

describe('F. 原生全屏请求被拒 → 降级兜底', () => {
  test('F1 requestFullscreen 返回 rejected promise → .catch 降级加 .immersive（不抛错）', async () => {
    const env = loadFsSandbox();
    const { reader, fullBtn, document, calls, api } = env;
    reader.requestFullscreen = () => Promise.reject(new Error('denied'));

    assert.doesNotThrow(
      () => api.togglePdfFullscreen(reader, makeDoc(10), 10, makeContainer(env), { id: 'bk' }),
      '拒绝不应同步抛错（应走 .catch 降级）'
    );
    // .catch 是微任务，等一拍让降级逻辑执行
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(reader.classList.contains('immersive'), '原生失败后应通过 .catch 降级加 .immersive');
    assert.equal(document.fullscreenElement, null, '降级不应启用原生全屏');
    assert.equal(fullBtn.textContent, '🔳 退出', '降级后按钮应显示 🔳 退出');
    assert.equal(calls.relayout, 1, '降级后应触发一次 pdfRelayout 按新宽度重排');
  });
});

/* ══════════════════════ G. CSS 校验（静态） ══════════════════════ */

describe('G. 全屏 CSS 规则校验', () => {
  test('G1 workbench.html 含 .pdf-reader.immersive 与 .pdf-reader:fullscreen 规则', () => {
    assert.ok(HTML.includes('.pdf-reader.immersive{'), '缺少 .pdf-reader.immersive 全屏规则');
    assert.ok(HTML.includes('.pdf-reader:fullscreen{'), '缺少 .pdf-reader:fullscreen 全屏规则');
  });

  test('G2 手机端 @media(max-width:760px) 下全屏 .pdf-toc.show 仍是浮层抽屉（display:flex），默认隐藏', () => {
    assert.ok(HTML.includes('@media (max-width:760px)'), '缺少手机端媒体查询');
    // 手机端全屏时目录默认隐藏
    assert.ok(
      HTML.includes('.pdf-reader.immersive .pdf-toc, .pdf-reader:fullscreen .pdf-toc{ display:none; }'),
      '手机端全屏下目录应默认 display:none'
    );
    // 但 .show 时仍是浮层抽屉（display:flex）
    assert.ok(
      HTML.includes('.pdf-reader.immersive .pdf-toc.show, .pdf-reader:fullscreen .pdf-toc.show{ display:flex; }'),
      '手机端全屏下 .pdf-toc.show 应 display:flex（沿用既有浮层抽屉逻辑）'
    );
    // 防御性正则：确认 show 规则确实落在手机端媒体查询块内且为 display:flex
    assert.ok(
      /@media\s*\(max-width:\s*760px\)[\s\S]*?\.pdf-reader\.immersive\s+\.pdf-toc\.show[\s\S]*?display:\s*flex/.test(HTML),
      '手机端媒体查询块内应包含 .pdf-toc.show 的 display:flex 规则'
    );
  });
});

/* ══════════════════════ H. 镜像一致 ══════════════════════ */

describe('H. workbench.html 与 index.html 字节级一致', () => {
  test('H1 两文件逐字节一致（全屏改动须同步到镜像）', () => {
    assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未与 workbench.html 字节级一致');
  });
});
