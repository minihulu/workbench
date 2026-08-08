/**
 * PDF 全屏批注浮层「挂载点选择」逻辑 —— 聚焦单元测试
 *
 * 背景：批注相关浮层（选中工具条 / 批注气泡 / 词汇 / 翻译 / 查词 / 编辑弹窗 / toast）
 * 原本都挂 document.body 或 reader 之外，原生全屏时只有 .pdf-reader 后代才渲染，
 * 导致全屏下不可见。修复新增 pdfFloatHost()：全屏（原生 :fullscreen 或 .immersive 兜底）
 * 时返回 .pdf-reader，否则返回 document.body。
 *
 * 策略（沿用 repo 现有 pdf-*.test.mjs / test_cog_english_behavior.test.mjs 范式）：
 * 不重新实现被测逻辑，从 workbench.html 按标记「抽取真实源码片段」pdfFloatHost，
 * 放进带 mini-DOM（可控 reader / body / fullscreenElement）的 vm 沙箱里真跑，断言源码本身。
 *
 * 覆盖：
 *  1 非全屏且非 immersive → 返回 document.body（零回归：与改动前行为一致）
 *  2 原生全屏：document.fullscreenElement === reader → 返回 reader
 *  3 原生全屏（webkit 前缀）：document.webkitFullscreenElement === reader → 返回 reader
 *  4 iOS 兜底 immersive：reader.classList.add('immersive') → 返回 reader
 *  5 边界：fullscreenElement 已设但不是 reader（如其他全屏节点）→ 返回 body（不放错节点）
 *  6 边界：页面无 .pdf-reader 且非全屏 → 返回 body（不抛错）
 *
 * ⚠️ 限制（详见测试报告）：jsdom 无法模拟真实原生全屏渲染（fullscreenElement 恒为 null，
 *   .immersive 不会真正铺满视口）。本测试只证明「挂载点选择逻辑」正确，真实全屏下的视觉
 *   渲染需 Chrome 桌面 + Safari/iOS 手动验证。
 */
import { test, describe } from 'node:test';
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

// 精确抽取真实 pdfFloatHost 函数（从函数声明到下一个函数 removePdfSelBtn 之前）。
const REGION_FLOAT_HOST = sliceBetween(
  HTML,
  'function pdfFloatHost(){',
  'function removePdfSelBtn(){',
  'floatHost'
);

/* ────────────────────────── mini-DOM mock ────────────────────────── */
function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: { cssText: '', width: '', height: '', left: '', top: '' },
    children: [],
    parentNode: null,
    textContent: '',
    width: 0, height: 0,
    offsetWidth: 0, offsetHeight: 0,
    onclick: null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
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
  return el;
}

/**
 * 构建挂载点选择沙箱：注入可控的 reader / body / fullscreenElement，
 * 并真跑抽取到的 pdfFloatHost，暴露给测试断言。
 */
function loadFloatHostSandbox() {
  const reader = makeEl('div');   // 模拟 .pdf-reader
  const body = makeEl('body');

  const document = {
    fullscreenElement: null,
    webkitFullscreenElement: null,
    body,
    querySelector: (sel) => (sel === '.pdf-reader' ? reader : null),
    querySelectorAll: () => [],
    createElement: (t) => makeEl(t),
    addEventListener() {}, removeEventListener() {},
  };

  const sandbox = {
    console,
    document,
    Math, JSON, Set, Map, Object, Array, String, Number, Boolean, Error, RegExp,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const epilogue = `
    globalThis.__api = { pdfFloatHost, getReader: () => __reader, getBody: () => __body };
  `;
  // 把受控的 reader / body 也透给测试，便于身份比较
  vm.runInContext(
    [REGION_FLOAT_HOST, 'var __reader = document.querySelector(".pdf-reader"); var __body = document.body;', epilogue].join('\n'),
    sandbox,
    { filename: 'workbench-floathost.js' }
  );

  return { api: sandbox.__api, document, reader, body };
}

/* ══════════════════════ 挂载点选择逻辑 ══════════════════════ */
describe('pdfFloatHost 挂载点选择', () => {
  test('1 非全屏且非 immersive → 返回 document.body（零回归）', () => {
    const env = loadFloatHostSandbox();
    env.document.fullscreenElement = null;
    env.document.webkitFullscreenElement = null;
    const host = env.api.pdfFloatHost();
    assert.strictEqual(host, env.body, '非全屏时应返回 body');
    assert.notStrictEqual(host, env.reader, '非全屏时不应返回 reader');
  });

  test('2 原生全屏：fullscreenElement === reader → 返回 reader', () => {
    const env = loadFloatHostSandbox();
    // 模拟浏览器进入原生全屏：document.fullscreenElement 指向 reader
    env.document.fullscreenElement = env.reader;
    env.document.webkitFullscreenElement = null;
    const host = env.api.pdfFloatHost();
    assert.strictEqual(host, env.reader, '原生全屏（fullscreenElement===reader）应返回 reader');
    assert.notStrictEqual(host, env.body, '原生全屏时不应返回 body');
  });

  test('3 原生全屏（webkit 前缀）：webkitFullscreenElement === reader → 返回 reader', () => {
    const env = loadFloatHostSandbox();
    // 老 Safari：仅 webkitFullscreenElement 生效，fullscreenElement 为 null
    env.document.fullscreenElement = null;
    env.document.webkitFullscreenElement = env.reader;
    const host = env.api.pdfFloatHost();
    assert.strictEqual(host, env.reader, 'webkit 前缀全屏应返回 reader');
    assert.notStrictEqual(host, env.body, 'webkit 全屏时不应返回 body');
  });

  test('4 iOS 兜底 immersive：reader 含 .immersive 类 → 返回 reader', () => {
    const env = loadFloatHostSandbox();
    env.document.fullscreenElement = null;
    env.document.webkitFullscreenElement = null;
    env.reader.classList.add('immersive');
    const host = env.api.pdfFloatHost();
    assert.strictEqual(host, env.reader, 'immersive 兜底应返回 reader');
    assert.notStrictEqual(host, env.body, 'immersive 兜底时不应返回 body');
  });

  test('5 边界：fullscreenElement 已设但不是 reader → 返回 body（不放错节点）', () => {
    const env = loadFloatHostSandbox();
    const other = makeEl('div'); // 其他全屏元素（非 .pdf-reader）
    env.document.fullscreenElement = other;
    env.document.webkitFullscreenElement = null;
    const host = env.api.pdfFloatHost();
    assert.strictEqual(host, env.body, 'fullscreenElement 不是 reader 时应退回 body');
    assert.notStrictEqual(host, env.reader, '不应误把浮层挂到 reader');
  });

  test('6 边界：页面无 .pdf-reader 且非全屏 → 返回 body（不抛错）', () => {
    const env = loadFloatHostSandbox();
    // 让 querySelector('.pdf-reader') 这次返回 null
    env.document.querySelector = (sel) => (sel === '.pdf-reader' ? null : null);
    env.document.fullscreenElement = null;
    env.document.webkitFullscreenElement = null;
    assert.doesNotThrow(() => env.api.pdfFloatHost(), '无 reader 时不应抛错');
    const host = env.api.pdfFloatHost();
    assert.strictEqual(host, env.body, '无 reader 且非全屏应返回 body');
  });

  test('7 一致性：immersive 与 fullscreen 同时存在时仍返回 reader（不会互相抵消）', () => {
    const env = loadFloatHostSandbox();
    env.reader.classList.add('immersive');
    env.document.fullscreenElement = env.reader;
    const host = env.api.pdfFloatHost();
    assert.strictEqual(host, env.reader, 'immersive + 原生全屏都应返回 reader');
  });
});
