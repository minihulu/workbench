/**
 * PDF 高清渲染 + 多端自适应 —— 回归测试
 *
 * 策略：不重新实现被测逻辑，而是从 workbench.html 中「按标记抽取真实源码片段」，
 * 放进带 DOM mock 的 vm 沙箱里真跑。这样断言的是线上代码本身，源码一改测试就会失效/报错。
 *
 * 覆盖：
 *   A 语法 / 双文件一致性 / 静态不变量
 *   B 核心数学：syncPdfScale、pdfDprFor、canvas 上限收敛
 *   C rVp / lVp 数据不变量（canvas 高清 + 文字层对齐）
 *   D resize 只绑一次 + debounce 上下文切换
 *   E pdfEvictFarPages 不误伤可见页 / 当前页 / 未渲染页
 *   F 既有功能符号未丢失
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// QA_TARGET_HTML 用于变异测试（对故意注入缺陷的副本跑同一套断言，验证测试确实有杀伤力）
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

// 区块 1：容器测宽 / scale / dpr / 回收 / 重排 / resize / 渲染
const REGION_CORE = sliceBetween(
  HTML,
  'let _pdfSbW = null;',
  'function setupScrollSpy(',
  'core'
);
// 区块 2：文字层
const REGION_TEXTLAYER = sliceBetween(
  HTML,
  'function buildTextLayer(textContent, viewport){',
  'function bindPdfSelection(',
  'textLayer'
);

/* ────────────────────────── DOM mock ────────────────────────── */

function makeStyle() {
  return { cssText: '', width: '', height: '', minHeight: '', position: '', left: '', top: '', fontSize: '', transform: '' };
}

function makeEl(tag, doc) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    dataset: {},
    style: makeStyle(),
    children: [],
    parentNode: null,
    textContent: '',
    // canvas
    width: 0,
    height: 0,
    // 布局量（测试可覆盖）
    clientWidth: 0,
    clientHeight: 0,
    scrollHeight: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    onscroll: null,
    onmouseup: null,
    _html: '',
    getContext: () => ({ __ctx: true, drawImage() {}, clearRect() {} }),
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    scrollIntoView() { el.__scrolledIntoView = (el.__scrolledIntoView || 0) + 1; },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: el.clientWidth, height: el.clientHeight, bottom: 0, right: 0 }),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
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
  Object.defineProperty(el, 'childNodes', { get: () => el.children });
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] || null });
  return el;
}

/**
 * 构建沙箱：注入 mock 全局 + 真实源码区块
 * @param {object} opts
 *   opts.devicePixelRatio  设备像素比
 *   opts.scrollbarWidth    模拟纵向滚动条宽度（探针 offsetWidth-clientWidth）
 *   opts.spanOffsetWidth   文字层 span 的 offsetWidth（触发横向校正分支）
 */
function loadSandbox(opts = {}) {
  const {
    devicePixelRatio = 1,
    scrollbarWidth = 0,
    spanOffsetWidth = 10,
  } = opts;

  const calls = {
    render: [],          // page.render 收到的 viewport
    textLayer: [],       // buildTextLayer 收到的 viewport
    resizeListeners: [], // window.addEventListener('resize', ...)
    applyHighlights: [],
    saveBookProgress: [],
    highlightToc: [],
    timers: [],
  };

  const body = makeEl('body');
  body.contains = (n) => {
    const walk = (p) => (p === n ? true : (p.children || []).some(walk));
    return (body.children || []).some(walk) || n === body || n.__inBody === true;
  };

  const document = {
    body,
    createElement(tag) {
      const el = makeEl(tag, document);
      if (String(tag).toLowerCase() === 'div' && el.style) {
        // 滚动条探针：cssText 里带 overflow:scroll 的那个 div
        Object.defineProperty(el, '__probe', { value: true, writable: true });
      }
      if (String(tag).toLowerCase() === 'span') el.offsetWidth = spanOffsetWidth;
      return el;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  // 探针宽度：pdfScrollbarWidth 会 append 一个 overflow:scroll 的 div 再读 offsetWidth-clientWidth
  const origAppend = body.appendChild;
  body.appendChild = (c) => {
    if (c && c.style && /overflow:\s*scroll/.test(c.style.cssText || '')) {
      c.offsetWidth = 100 + scrollbarWidth;
      c.clientWidth = 100;
    }
    return origAppend(c);
  };

  const windowObj = {
    devicePixelRatio,
    addEventListener(type, fn) { if (type === 'resize') calls.resizeListeners.push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  };

  const sandbox = {
    console,
    window: windowObj,
    document,
    getComputedStyle: (el) => ({
      paddingLeft: (el && el.__padL != null ? el.__padL : 0) + 'px',
      paddingRight: (el && el.__padR != null ? el.__padR : 0) + 'px',
    }),
    setTimeout: (fn, ms) => { const id = calls.timers.length; calls.timers.push({ fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { if (calls.timers[id]) calls.timers[id].cleared = true; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    IntersectionObserver: class { constructor(cb, o) { this.cb = cb; this.opts = o; } observe() {} disconnect() {} },
    Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number, parseFloat, parseInt, isNaN,
    __calls: calls,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const prelude = `
    // ── 被测区块外部的全局状态（与 workbench.html L3363-3374 保持一致）──
    var pdfDoc=null, pdfTotal=0, pdfScale=1.4;
    var pdfFitScale=1.4, pdfZoom=1;
    var pdfBook=null, pdfPagesEl=null, pdfSourceRaw=null;
    var pdfMode='page', pdfPageDivs={}, pdfRendered=new Set(), pdfIO=null;
    var pdfVisible=new Set();
    var pdfCurrentPage=1, pdfJumpTo=null;
    // ── 被测区块外部依赖的函数：桩 ──
    var __els={};
    function $(sel){ return __els[sel] || null; }
    function applyHighlights(a,b,c){ __calls.applyHighlights.push([a&&a.tagName,b,c]); }
    function saveBookProgress(b,n){ __calls.saveBookProgress.push([b&&b.id,n]); }
    function highlightTocCurrent(n){ __calls.highlightToc.push(n); }
    function setupScrollSpy(){}
    function toast(){}
  `;

  const epilogue = `
    globalThis.__api = {
      pdfScrollbarWidth, pdfContainerWidth, syncPdfScale, pdfDprFor,
      pdfEvictFarPages, pdfRelayout, onPdfZoom, bindPdfResize, onPdfViewportResize,
      pdfGoToPage, renderPage, renderScrollPage, layoutScroll, buildTextLayer,
      PDF_MAX_CANVAS_PX, PDF_MAX_CANVAS_SIDE, PDF_KEEP_PAGES,
      get: (k)=>eval(k),
      set: (k,v)=>{ eval(k+' = v'); },
      stubRender(){
        renderPage = async function(doc,total,pagesEl,b,n){ globalThis.__calls.render.push({stub:'page',n}); pdfCurrentPage=n; };
        renderScrollPage = async function(doc,total,pagesEl,b,n){ globalThis.__calls.render.push({stub:'scroll',n}); pdfRendered.add(n); };
      },
      registerEl(sel, el){ __els[sel] = el; }
    };
  `;

  const src = prelude + '\n' + REGION_CORE + '\n' + REGION_TEXTLAYER + '\n' + epilogue;
  vm.runInContext(src, sandbox, { filename: 'workbench-extracted.js' });
  return { api: sandbox.__api, calls, document, window: windowObj, sandbox, makeEl: (t) => makeEl(t, document) };
}

/**
 * vm 沙箱里造出的对象/数组来自另一个 realm，原型与宿主不同，
 * deepStrictEqual 会因「结构相同但引用不同」失败。比较前先归一化。
 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ── A4 假 page：pdf.js viewport 语义（transform = [s,0,0,-s,0,H]）── */
const A4_W = 612, A4_H = 792;
function makePage(w = A4_W, h = A4_H) {
  return {
    getViewport({ scale }) {
      return { width: w * scale, height: h * scale, scale, transform: [scale, 0, 0, -scale, 0, h * scale] };
    },
    render(params) {
      globalThis.__lastRender = params;
      return { promise: Promise.resolve() };
    },
    getTextContent: async () => ({ items: [{ str: 'Hello', width: 30, transform: [12, 0, 0, 12, 72, 700] }] }),
  };
}
function makeDoc(page, numPages = 50) {
  return { numPages, getPage: async () => page };
}

/* 让沙箱内的 page.render / buildTextLayer 可被外部观察 */
function instrument(env, page) {
  const realBuild = env.api.buildTextLayer;
  env.api.set('buildTextLayer', function (tc, vp) {
    env.calls.textLayer.push(vp);
    return realBuild(tc, vp);
  });
  page.render = (params) => { env.calls.render.push(params.viewport); return { promise: Promise.resolve() }; };
  return page;
}

/* 造一个可被 pdfContainerWidth 测出指定宽度的容器 */
function makeContainer(env, contentWidth, { padL = 0, padR = 0, scrollbar = 0 } = {}) {
  const el = env.makeEl('div');
  // pdfContainerWidth: (clientWidth - padL - padR [- sbw]) → floor -2
  el.clientWidth = contentWidth + padL + padR + scrollbar + 2;
  el.__padL = padL; el.__padR = padR;
  el.clientHeight = 800;
  el.scrollHeight = 99999; // 已有滚动条 → 不再额外扣减
  el.__inBody = true;
  return el;
}

/* ══════════════════════ A. 语法 / 一致性 / 静态不变量 ══════════════════════ */

describe('A. 语法、双文件一致性与静态不变量', () => {
  test('A1 workbench.html 与 index.html 完全一致（同步无遗漏）', () => {
    assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未与 workbench.html 同步');
  });

  test('A2 内联主脚本语法合法（可被 JS 引擎解析）', () => {
    const m = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(m, '未找到内联脚本');
    assert.doesNotThrow(() => new vm.Script(m[1], { filename: 'inline.js' }));
  });

  test('A3 抽取出的核心区块可独立解析（无残缺括号）', () => {
    assert.doesNotThrow(() => new vm.Script(REGION_CORE + '\n' + REGION_TEXTLAYER));
  });

  test('A4 高清渲染写法出现次数正确（单页 + 滚动各一处）', () => {
    const count = (re) => (HTML.match(re) || []).length;
    assert.equal(count(/viewport:\s*rVp/g), 2, 'render 必须用物理 viewport rVp');
    assert.equal(count(/buildTextLayer\(\s*textContent\s*,\s*lVp\s*\)/g), 2, '文字层必须用逻辑 viewport lVp');
    assert.equal(count(/getViewport\(\{\s*scale:\s*pdfScale\s*\}\)/g), 2);
    assert.equal(count(/getViewport\(\{\s*scale:\s*pdfScale\s*\*\s*dpr\s*\}\)/g), 2);
    assert.equal(count(/pdfDprFor\(lVp\)/g), 2, 'dpr 必须基于逻辑尺寸计算上限');
    assert.equal(count(/canvas\.width\s*=\s*Math\.floor\(rVp\.width\)/g), 2);
    assert.equal(count(/canvas\.style\.width\s*=\s*Math\.floor\(lVp\.width\)/g), 2);
  });

  test('A5 旧的模糊写法已彻底清除', () => {
    const count = (re) => (HTML.match(re) || []).length;
    assert.equal(count(/canvasContext:\s*ctx\s*,\s*viewport\s*\}/g), 0, '仍存在未区分 rVp/lVp 的旧渲染写法');
    assert.equal(count(/buildTextLayer\(\s*textContent\s*,\s*viewport\s*\)\s*\)/g), 0, '仍存在旧文字层写法');
    assert.equal(count(/const\s+viewport\s*=\s*page\.getViewport/g), 0, '仍存在单一 viewport 变量的旧写法');
  });

  test('A6 window resize 全局只绑一次（守卫存在且包裹 addEventListener）', () => {
    const fn = sliceBetween(HTML, 'function bindPdfResize(', 'function onPdfViewportResize(', 'bindPdfResize');
    assert.match(fn, /if\(_pdfResizeBound\)\s*return/, '缺少 _pdfResizeBound 守卫');
    const guardAt = fn.indexOf('if(_pdfResizeBound) return');
    const listenAt = fn.indexOf("window.addEventListener('resize'");
    assert.ok(guardAt !== -1 && listenAt !== -1 && guardAt < listenAt, 'addEventListener 必须在守卫之后');
    assert.equal((HTML.match(/window\.addEventListener\(\s*'resize'/g) || []).length, 1, '全局只应有一处 resize 监听');
    assert.match(fn, /_pdfResizeTimer\s*=\s*setTimeout\(onPdfViewportResize,\s*200\)/, 'debounce 应为 200ms');
  });

  test('A7 CSS 兜底 .pdf-page.fit{max-width:100%} 存在', () => {
    assert.match(HTML, /\.pdf-page\.fit\s*\{[^}]*max-width:\s*100%/, '缺少移动端 max-width 兜底');
  });
});

/* ══════════════════════ B. 核心数学 ══════════════════════ */

describe('B. syncPdfScale / pdfDprFor 数学正确性', () => {
  test('B1 syncPdfScale：桌面 1200px → fitScale = 1200/612，pdfZoom=1 时 pdfScale 相同', () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const page = makePage();
    const s = env.api.syncPdfScale(page, 1200);
    const expected = 1200 / A4_W;
    assert.ok(Math.abs(env.api.get('pdfFitScale') - expected) < 1e-9, `fitScale=${env.api.get('pdfFitScale')}`);
    assert.ok(Math.abs(s - expected) < 1e-9);
    // 关键：fit 之后逻辑宽度正好等于容器宽度
    assert.ok(Math.abs(page.getViewport({ scale: s }).width - 1200) < 1e-6, '适应宽度后逻辑宽应恰为容器宽');
  });

  test('B2 syncPdfScale：pdfZoom 线性叠加在 fitScale 之上', () => {
    const env = loadSandbox();
    const page = makePage();
    env.api.set('pdfZoom', 1.5);
    const s = env.api.syncPdfScale(page, 1200);
    assert.ok(Math.abs(s - (1200 / A4_W) * 1.5) < 1e-9);
    assert.ok(Math.abs(env.api.get('pdfFitScale') - 1200 / A4_W) < 1e-9, 'fitScale 不应被 zoom 污染');
  });

  test('B3 syncPdfScale：fitScale 被夹在 [0.1, 6]，异常 page 不抛出', () => {
    const env = loadSandbox();
    // 超宽容器 → 上限 6
    env.api.syncPdfScale(makePage(), 100000);
    assert.equal(env.api.get('pdfFitScale'), 6);
    // 极窄容器 → 下限 0.1
    env.api.syncPdfScale(makePage(), 1);
    assert.ok(env.api.get('pdfFitScale') >= 0.1);
    // page.getViewport 抛错 → 静默保留上次值，不崩
    const before = env.api.get('pdfFitScale');
    assert.doesNotThrow(() => env.api.syncPdfScale({ getViewport() { throw new Error('boom'); } }, 1200));
    assert.equal(env.api.get('pdfFitScale'), before);
  });

  test('B4 pdfDprFor：桌面 1200px + DPR2 → 吃满 2×，未触发任何上限', () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const page = makePage();
    const s = env.api.syncPdfScale(page, 1200);
    const lVp = page.getViewport({ scale: s });
    const dpr = env.api.pdfDprFor(lVp);
    assert.equal(dpr, 2, '桌面常规尺寸应吃满 devicePixelRatio');
    const rVp = page.getViewport({ scale: s * dpr });
    assert.ok(Math.abs(rVp.width - 2400) < 1e-6, `canvas 物理宽应为 1200×2=2400，实际 ${rVp.width}`);
    assert.ok(Math.max(rVp.width, rVp.height) <= env.api.PDF_MAX_CANVAS_SIDE);
    assert.ok(rVp.width * rVp.height <= env.api.PDF_MAX_CANVAS_PX);
  });

  test('B5 pdfDprFor：手机 340px + DPR3 → 吃满 3×（小屏高 DPR 是清晰度收益最大场景）', () => {
    const env = loadSandbox({ devicePixelRatio: 3 });
    const page = makePage();
    const s = env.api.syncPdfScale(page, 340);
    const lVp = page.getViewport({ scale: s });
    assert.equal(env.api.pdfDprFor(lVp), 3);
    const rVp = page.getViewport({ scale: s * 3 });
    assert.ok(Math.abs(rVp.width - 1020) < 1e-6);
    assert.ok(rVp.width * rVp.height <= env.api.PDF_MAX_CANVAS_PX);
  });

  test('B6 pdfDprFor：4K 2400px + DPR2 + zoom3 → 必须被收敛到满足边长/面积双上限', () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const page = makePage();
    env.api.set('pdfZoom', 3);
    const s = env.api.syncPdfScale(page, 2400);
    const lVp = page.getViewport({ scale: s });
    // 未收敛时会是 7200×2 = 14400 宽、18635 高 —— 双双爆表
    assert.ok(lVp.width * 2 > env.api.PDF_MAX_CANVAS_SIDE, '前置条件：未收敛确实超限');
    const dpr = env.api.pdfDprFor(lVp);
    assert.ok(dpr < 2, `必须降倍率，实际 ${dpr}`);
    const rVp = page.getViewport({ scale: s * dpr });
    assert.ok(Math.max(rVp.width, rVp.height) <= env.api.PDF_MAX_CANVAS_SIDE + 1, `单边超限 ${Math.max(rVp.width, rVp.height)}`);
    assert.ok(rVp.width * rVp.height <= env.api.PDF_MAX_CANVAS_PX + 1, `面积超限 ${rVp.width * rVp.height}`);
    assert.ok(dpr >= 0.25, 'dpr 不得低于 0.25 下限');
  });

  test('B7 pdfDprFor：面积/边长上限的边界行为', () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    // 细长页：只触发边长上限而非面积上限
    const long = { width: 5000, height: 100 };
    const r1 = env.api.pdfDprFor(long);
    assert.ok(r1 * 5000 <= env.api.PDF_MAX_CANVAS_SIDE + 1e-6, '边长上限未生效');
    // 大面积页：触发面积上限
    const big = { width: 4000, height: 4000 };
    const r2 = env.api.pdfDprFor(big);
    assert.ok(4000 * r2 * 4000 * r2 <= env.api.PDF_MAX_CANVAS_PX + 1, '面积上限未生效');
    // 兜底：viewport 缺失字段不崩
    assert.ok(env.api.pdfDprFor({}) > 0);
  });

  test('B8 pdfDprFor：devicePixelRatio 异常（0 / undefined / NaN）时回落为 1', () => {
    for (const bad of [0, undefined, NaN, -1]) {
      const env = loadSandbox({ devicePixelRatio: bad });
      assert.equal(env.api.pdfDprFor({ width: 800, height: 1000 }), 1, `dpr=${bad} 未回落为 1`);
    }
  });

  test('B9 【安全上界】在业务可达的最大放大倍数下，canvas 永不超限且不触及 0.25 地板', () => {
    // pdfScale 上界 = fitScale上限(6) × pdfZoom上限(3) = 18
    const env = loadSandbox({ devicePixelRatio: 3 });
    const page = makePage();
    const lVp = page.getViewport({ scale: 18 });
    const dpr = env.api.pdfDprFor(lVp);
    const rVp = page.getViewport({ scale: 18 * dpr });
    assert.ok(Math.max(rVp.width, rVp.height) <= env.api.PDF_MAX_CANVAS_SIDE + 1);
    assert.ok(rVp.width * rVp.height <= env.api.PDF_MAX_CANVAS_PX + 1);
    assert.ok(dpr > 0.25, `业务可达区间内不应触发 0.25 地板（会突破面积上限），实际 ${dpr}`);
  });

  test('B10 【阈值刻画】记录 dpr 跌破 1（渲染分辨率低于 CSS 分辨率）的临界点', () => {
    // 面积上限 12M px 决定：逻辑页宽超过约 3118 CSS px 后 dpr 就 < 1。
    // 换算成用户操作：dpr<1 ⟺ 阅读区宽度 × 缩放倍数 > ~3118。
    // 本用例把这个阈值钉住 —— 一旦 PDF_MAX_CANVAS_PX 调整，这里会立刻反映出来。
    const env = loadSandbox({ devicePixelRatio: 2 });
    const page = makePage();
    const ratio = A4_H / A4_W;
    const wThreshold = Math.sqrt(env.api.PDF_MAX_CANVAS_PX / ratio);
    assert.ok(Math.abs(wThreshold - 3118) < 5, `阈值应约 3118px，实际 ${wThreshold.toFixed(0)}`);

    const dprAt = (cw, zoom) => {
      const e = loadSandbox({ devicePixelRatio: 2 });
      const p = makePage();
      e.api.set('pdfZoom', zoom);
      const s = e.api.syncPdfScale(p, cw);
      return e.api.pdfDprFor(p.getViewport({ scale: s }));
    };
    // 默认缩放：各档设备都应 ≥1（高清目标达成）
    assert.ok(dprAt(340, 1) >= 1, '手机默认缩放必须高清');
    assert.ok(dprAt(1200, 1) >= 1, '桌面默认缩放必须高清');
    assert.ok(dprAt(2400, 1) >= 1, '4K 默认缩放必须高清');
    // 阈值另一侧：dpr 跌破 1（当前实现的已知取舍）
    assert.ok(dprAt(2400, 1.4) < 1, '4K + 140% 已跌破 1（已知取舍，见测试报告）');
    assert.ok(dprAt(1200, 3) < 1, '桌面 + 300% 已跌破 1（已知取舍，见测试报告）');
    // 但无论如何都不会低到不可读，且始终守住 canvas 硬上限
    for (const [cw, z] of [[2400, 3], [1200, 3], [3672, 3]]) {
      const d = dprAt(cw, z);
      assert.ok(d >= 0.25, `dpr 过低：cw=${cw} zoom=${z} → ${d}`);
    }
  });
});

/* ══════════════════════ C. rVp / lVp 不变量（真跑 renderPage） ══════════════════════ */

describe('C. 渲染用 rVp、文字层用 lVp —— 端到端不变量', () => {
  for (const [label, cw, dpr, zoom] of [
    ['桌面 1200 / DPR2', 1200, 2, 1],
    ['手机 340 / DPR3', 340, 3, 1],
    ['4K 2400 / DPR2 / zoom3', 2400, 2, 3],
    ['低端 800 / DPR1', 800, 1, 1],
  ]) {
    test(`C1 [${label}] 单页模式 renderPage：canvas 物理=rVp，CSS=lVp，文字层=lVp`, async () => {
      const env = loadSandbox({ devicePixelRatio: dpr });
      const page = instrument(env, makePage());
      const doc = makeDoc(page);
      const pagesEl = makeContainer(env, cw);
      env.api.set('pdfZoom', zoom);

      await env.api.renderPage(doc, 50, pagesEl, { id: 'bk1' }, 7);

      // 结构：pagesEl > pageDiv > [canvas, textLayer]
      const pageDiv = pagesEl.children[0];
      assert.ok(pageDiv, '未产出 pdf-page 容器');
      const canvas = pageDiv.children.find((c) => c.tagName === 'CANVAS');
      assert.ok(canvas, '未产出 canvas');

      assert.equal(env.calls.render.length, 1, 'page.render 应恰好调用一次');
      assert.equal(env.calls.textLayer.length, 1, 'buildTextLayer 应恰好调用一次');
      const rVp = env.calls.render[0];
      const lVp = env.calls.textLayer[0];

      // ① 渲染 viewport 严格 = 逻辑 viewport × dpr
      const ratio = rVp.width / lVp.width;
      assert.ok(Math.abs(rVp.height / lVp.height - ratio) < 1e-9, '宽高倍率必须一致（等比）');
      assert.ok(Math.abs(rVp.width - lVp.width * ratio) <= 1, 'rVp.width ≠ lVp.width × dpr');
      assert.ok(Math.abs(rVp.height - lVp.height * ratio) <= 1, 'rVp.height ≠ lVp.height × dpr');
      assert.ok(ratio >= 1 || zoom > 1, `常规场景倍率应 ≥1（高清），实际 ${ratio}`);

      // ② canvas 位图尺寸用 rVp（高清的来源）
      assert.equal(canvas.width, Math.floor(rVp.width));
      assert.equal(canvas.height, Math.floor(rVp.height));

      // ③ canvas CSS 尺寸用 lVp（布局的来源）
      assert.equal(canvas.style.width, Math.floor(lVp.width) + 'px');
      assert.equal(canvas.style.height, Math.floor(lVp.height) + 'px');

      // ④ 文字层拿到的就是 lVp，且尺寸与 canvas 的 CSS 盒严格一致 → 高亮/选中不偏移
      const textLayer = pageDiv.children.find((c) => c.__classes && c.__classes.has('textLayer'));
      assert.ok(textLayer, '未产出 textLayer');
      assert.equal(textLayer.style.width, canvas.style.width, '文字层宽 ≠ canvas CSS 宽 → 选中会偏移');
      assert.equal(textLayer.style.height, canvas.style.height, '文字层高 ≠ canvas CSS 高 → 选中会偏移');

      // ⑤ 外层 pageDiv 宽度也用逻辑宽
      assert.equal(pageDiv.style.width, Math.floor(lVp.width) + 'px');
    });
  }

  test('C2 滚动模式 renderScrollPage 遵守同一组不变量', async () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const page = instrument(env, makePage());
    const doc = makeDoc(page);
    const pagesEl = makeContainer(env, 1000);
    const slot = env.makeEl('div');
    slot.__inBody = true;
    env.api.set('pdfMode', 'scroll');
    env.api.set('pdfPageDivs', { 3: slot });

    await env.api.renderScrollPage(doc, 50, pagesEl, { id: 'bk1' }, 3);

    const pageDiv = slot.children[0];
    const canvas = pageDiv.children.find((c) => c.tagName === 'CANVAS');
    const rVp = env.calls.render[0], lVp = env.calls.textLayer[0];
    assert.equal(canvas.width, Math.floor(rVp.width));
    assert.equal(canvas.style.width, Math.floor(lVp.width) + 'px');
    assert.ok(rVp.width / lVp.width > 1, '滚动模式同样应高清渲染');
    const textLayer = pageDiv.children.find((c) => c.__classes && c.__classes.has('textLayer'));
    assert.equal(textLayer.style.width, canvas.style.width);
    assert.ok(env.api.get('pdfRendered').has(3), '渲染完成应记入 pdfRendered');
  });

  test('C3 【差分证明】若文字层误用 rVp，尺寸与变换会整体放大 dpr 倍（当前实现未发生）', () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const page = makePage();
    const s = env.api.syncPdfScale(page, 1200);
    const lVp = page.getViewport({ scale: s });
    const dpr = env.api.pdfDprFor(lVp);
    const rVp = page.getViewport({ scale: s * dpr });
    const tc = { items: [{ str: 'A', width: 30, transform: [12, 0, 0, 12, 72, 700] }] };

    const good = env.api.buildTextLayer(tc, lVp);
    const bad = env.api.buildTextLayer(tc, rVp);
    assert.notEqual(good.style.width, bad.style.width, '差分前提：两者应不同');
    assert.equal(parseFloat(bad.style.width), Math.floor(rVp.width), 'rVp 版宽度确实会放大 dpr 倍');
    assert.equal(parseFloat(good.style.width), Math.floor(lVp.width), '当前实现用的是 lVp');
    // 文字定位（matrix 平移分量）在 rVp 版本下同样被放大 → 选中框整体错位
    const tGood = good.children[0].style.transform, tBad = bad.children[0].style.transform;
    const eGood = tGood.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number);
    const eBad = tBad.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number);
    assert.ok(Math.abs(eBad[5] / eGood[5] - dpr) < 1e-6, `rVp 版 Y 偏移应放大 ${dpr} 倍`);
  });

  test('C4 pdfZoom ≤1 时加 fit 类（吃 max-width:100% 兜底），>1 时不加（允许横向滚动）', async () => {
    for (const [zoom, shouldFit] of [[1, true], [0.8, true], [1.4, false]]) {
      const env = loadSandbox({ devicePixelRatio: 2 });
      const page = instrument(env, makePage());
      const pagesEl = makeContainer(env, 900);
      env.api.set('pdfZoom', zoom);
      await env.api.renderPage(makeDoc(page), 10, pagesEl, { id: 'b' }, 1);
      const pageDiv = pagesEl.children[0];
      assert.equal(pageDiv.__classes.has('fit'), shouldFit, `zoom=${zoom} 的 fit 类判定错误`);
      assert.ok(pageDiv.__classes.has('pdf-page'));
    }
  });

  test('C5 renderPage 在渲染后仍完成既有副作用（页码 / 目录 / 高亮 / 进度）', async () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const page = instrument(env, makePage());
    const info = env.makeEl('div');
    env.api.registerEl('#pdfPageInfo', info);
    const pagesEl = makeContainer(env, 1000);
    await env.api.renderPage(makeDoc(page), 42, pagesEl, { id: 'bk9' }, 12);
    assert.equal(env.api.get('pdfCurrentPage'), 12);
    assert.equal(info.textContent, '第 12 / 42 页');
    assert.deepEqual(plain(env.calls.highlightToc), [12]);
    assert.deepEqual(plain(env.calls.applyHighlights), [['DIV', 'bk9', 12]]);
    assert.deepEqual(plain(env.calls.saveBookProgress), [['bk9', 12]]);
  });

  test('C6 renderScrollPage 渲染异常时回滚 pdfRendered 并提示（不留脏状态）', async () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const doc = { numPages: 10, getPage: async () => { throw new Error('corrupt'); } };
    const slot = env.makeEl('div');
    env.api.set('pdfMode', 'scroll');
    env.api.set('pdfPageDivs', { 5: slot });
    await env.api.renderScrollPage(doc, 10, makeContainer(env, 900), { id: 'b' }, 5);
    assert.equal(env.api.get('pdfRendered').has(5), false, '失败页必须从 pdfRendered 移除，否则永不重试');
    assert.match(slot.innerHTML, /渲染失败/);
  });
});

/* ══════════════════════ D. 容器测宽 & resize 守卫 ══════════════════════ */

describe('D. pdfContainerWidth 与 resize 绑定', () => {
  test('D1 pdfContainerWidth 扣除 padding 并留 2px 余量', () => {
    const env = loadSandbox();
    const el = env.makeEl('div');
    el.clientWidth = 1000; el.__padL = 24; el.__padR = 24;
    el.clientHeight = 500; el.scrollHeight = 9999; // 已有滚动条
    assert.equal(env.api.pdfContainerWidth(el), 1000 - 48 - 2);
  });

  test('D2 尚未出现纵向滚动条时，预留滚动条宽度（避免渲染后横向溢出）', () => {
    const env = loadSandbox({ scrollbarWidth: 15 });
    const el = env.makeEl('div');
    el.clientWidth = 1000; el.clientHeight = 500; el.scrollHeight = 500; // 无滚动条
    assert.equal(env.api.pdfContainerWidth(el), 1000 - 15 - 2);
    assert.equal(env.api.pdfScrollbarWidth(), 15);
  });

  test('D3 极窄 / 空容器有下限保护，不产生 0 或负宽度', () => {
    const env = loadSandbox();
    const el = env.makeEl('div');
    el.clientWidth = 10; el.clientHeight = 10; el.scrollHeight = 999;
    assert.equal(env.api.pdfContainerWidth(el), 120, '应回落到 120px 下限');
    assert.equal(env.api.pdfContainerWidth(null), 0, '无容器时返回 0（调用方会跳过 fit 计算）');
  });

  test('D4 【内存泄漏防护】多次开书只绑一次 window resize 监听', () => {
    const env = loadSandbox();
    env.api.stubRender();
    const a = makeContainer(env, 1000), b = makeContainer(env, 1000), c = makeContainer(env, 800);
    env.api.bindPdfResize({}, 10, a, { id: 'b1' });
    env.api.bindPdfResize({}, 20, b, { id: 'b2' });
    env.api.bindPdfResize({}, 30, c, { id: 'b3' });
    assert.equal(env.calls.resizeListeners.length, 1, `重复绑定 window 监听（${env.calls.resizeListeners.length} 个）→ 内存泄漏 + 重复重排`);
  });

  test('D5 重复 bind 会把上下文切到最新阅读器（旧 doc 不再被重排）', () => {
    const env = loadSandbox();
    env.api.stubRender();
    const oldEl = makeContainer(env, 1000), newEl = makeContainer(env, 700);
    env.api.bindPdfResize({ tag: 'old' }, 10, oldEl, { id: 'b1' });
    env.api.bindPdfResize({ tag: 'new' }, 20, newEl, { id: 'b2' });
    const ctx = env.api.get('_pdfResizeCtx');
    assert.equal(ctx.doc.tag, 'new');
    assert.equal(ctx.pagesEl, newEl);
    assert.equal(ctx.total, 20);
  });

  test('D6 resize 事件走 200ms debounce，且连续触发会取消前一个定时器', () => {
    const env = loadSandbox();
    env.api.stubRender();
    env.api.bindPdfResize({}, 10, makeContainer(env, 1000), { id: 'b' });
    const handler = env.calls.resizeListeners[0];
    handler(); handler(); handler();
    assert.equal(env.calls.timers.length, 3, '每次 resize 都应重置定时器');
    assert.ok(env.calls.timers.every((t) => t.ms === 200), 'debounce 必须是 200ms');
    assert.equal(env.calls.timers[0].cleared, true, '前序定时器应被 clearTimeout');
    assert.equal(env.calls.timers[1].cleared, true);
    assert.equal(env.calls.timers[2].cleared, false, '最后一个定时器应保留执行');
  });

  test('D7 onPdfViewportResize：宽度实质变化才重排，微小抖动被忽略', () => {
    const env = loadSandbox();
    env.api.stubRender();
    const el = makeContainer(env, 1000);
    env.api.bindPdfResize({}, 10, el, { id: 'b' });
    const before = env.calls.render.length;

    // 抖动 4px（< 8px 阈值）→ 不重排
    el.clientWidth += 4;
    env.api.onPdfViewportResize();
    assert.equal(env.calls.render.length, before, '小于 8px 的抖动不应触发重排（移动端地址栏收起）');

    // 真实变化 300px → 重排
    el.clientWidth -= 304;
    env.api.onPdfViewportResize();
    assert.ok(env.calls.render.length > before, '容器宽度实质变化必须触发重排');
  });

  test('D8 onPdfViewportResize：DPR 变化（拖到副屏）也触发重排', () => {
    const env = loadSandbox({ devicePixelRatio: 1 });
    env.api.stubRender();
    const el = makeContainer(env, 1000);
    env.api.bindPdfResize({}, 10, el, { id: 'b' });
    const before = env.calls.render.length;
    env.window.devicePixelRatio = 2;   // 宽度不变，只有 DPR 变
    env.api.onPdfViewportResize();
    assert.ok(env.calls.render.length > before, 'DPR 变化应重新按新倍率渲染');
  });

  test('D9 阅读器已卸载时 resize 不再重排，并清空上下文（防悬挂引用）', () => {
    const env = loadSandbox();
    env.api.stubRender();
    const el = makeContainer(env, 1000);
    el.__inBody = false;   // 已从 DOM 移除
    env.api.bindPdfResize({}, 10, el, { id: 'b' });
    const before = env.calls.render.length;
    env.api.onPdfViewportResize();
    assert.equal(env.calls.render.length, before);
    assert.equal(env.api.get('_pdfResizeCtx'), null, '应释放对已卸载阅读器的引用');
  });

  test('D10 pdfRelayout：单页模式重渲染当前页；滚动模式重排已渲染页并清掉冻结高度', async () => {
    const env = loadSandbox();
    env.api.stubRender();
    // 单页
    env.api.set('pdfCurrentPage', 9);
    env.api.pdfRelayout({}, 50, makeContainer(env, 900), { id: 'b' });
    assert.deepEqual(plain(env.calls.render.at(-1)), { stub: 'page', n: 9 });

    // 滚动
    const env2 = loadSandbox();
    env2.api.stubRender();
    env2.api.set('pdfMode', 'scroll');
    env2.api.set('pdfCurrentPage', 5);
    const slots = {};
    [3, 4, 5].forEach((n) => { const s = env2.makeEl('div'); s.style.minHeight = '900px'; slots[n] = s; });
    env2.api.set('pdfPageDivs', slots);
    env2.api.set('pdfRendered', new Set([3, 4, 5]));
    env2.api.pdfRelayout({}, 50, makeContainer(env2, 900), { id: 'b' });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(env2.calls.render.map((c) => c.n).sort(), [3, 4, 5]);
    [3, 4, 5].forEach((n) => assert.equal(slots[n].style.minHeight, '', `第 ${n} 页回收时冻结的高度未清除 → 新宽度下高度错误`));
  });

  test('D11 onPdfZoom 更新倍率显示并触发重排', () => {
    const env = loadSandbox();
    env.api.stubRender();
    const label = env.makeEl('span');
    env.api.registerEl('#pdfZoomVal', label);
    env.api.set('pdfCurrentPage', 2);
    env.api.onPdfZoom({}, 10, makeContainer(env, 900), { id: 'b' }, 1.4);
    assert.equal(env.api.get('pdfZoom'), 1.4);
    assert.equal(label.textContent, '140%');
    assert.deepEqual(plain(env.calls.render.at(-1)), { stub: 'page', n: 2 });
  });
});

/* ══════════════════════ E. 显存回收 ══════════════════════ */

describe('E. pdfEvictFarPages 不误伤', () => {
  function setupScroll(env, { rendered, visible, current }) {
    const slots = {};
    for (let i = 1; i <= 30; i++) { const s = env.makeEl('div'); s.offsetHeight = 900; slots[i] = s; }
    env.api.set('pdfMode', 'scroll');
    env.api.set('pdfPageDivs', slots);
    env.api.set('pdfRendered', new Set(rendered));
    env.api.set('pdfVisible', new Set(visible));
    env.api.set('pdfCurrentPage', current);
    return slots;
  }

  test('E1 回收后保留 PDF_KEEP_PAGES 页，由远及近淘汰', () => {
    const env = loadSandbox();
    const slots = setupScroll(env, { rendered: [1,2,3,4,5,6,7,8,9,10,11,12], visible: [5,6,7], current: 6 });
    env.api.pdfEvictFarPages();
    const left = [...env.api.get('pdfRendered')].sort((a, b) => a - b);
    assert.equal(left.length, env.api.PDF_KEEP_PAGES, `应保留 ${env.api.PDF_KEEP_PAGES} 页，实际 ${left}`);
    assert.deepEqual(left, [4, 5, 6, 7, 8, 9], `应保留当前页附近，实际 ${left}`);
    // 被回收的页恢复成占位并冻结高度
    [1, 2, 3, 10, 11, 12].forEach((n) => {
      assert.match(slots[n].innerHTML, new RegExp(`第 ${n} 页`), `第 ${n} 页未恢复占位`);
      assert.equal(slots[n].style.minHeight, '900px', `第 ${n} 页未冻结高度 → 滚动条会跳`);
    });
  });

  test('E2 【关键】当前页永不被回收，即使它不在 pdfVisible 里', () => {
    const env = loadSandbox();
    setupScroll(env, { rendered: [1,2,3,4,5,6,7,8,9,10], visible: [], current: 1 });
    env.api.pdfEvictFarPages();
    assert.ok(env.api.get('pdfRendered').has(1), '当前页被回收 → 用户会看到白页');
  });

  test('E3 【关键】可视区内页（含 400px rootMargin 预加载页）永不被回收', () => {
    const env = loadSandbox();
    // 当前页 20，但 1/2 仍在 pdfVisible（极端构造）→ 距离最远却必须保留
    setupScroll(env, { rendered: [1,2,15,16,17,18,19,20,21,22], visible: [1,2,19,20,21], current: 20 });
    env.api.pdfEvictFarPages();
    const left = env.api.get('pdfRendered');
    [1, 2, 19, 20, 21].forEach((n) => assert.ok(left.has(n), `可视页 ${n} 被误回收 → 用户眼前的页变白`));
  });

  test('E4 未渲染过的页不受影响（不会被写占位、不进 pdfRendered）', () => {
    const env = loadSandbox();
    const slots = setupScroll(env, { rendered: [1,2,3,4,5,6,7,8,9,10], visible: [5], current: 5 });
    slots[25]._html = 'UNTOUCHED';
    env.api.pdfEvictFarPages();
    assert.equal(slots[25].innerHTML, 'UNTOUCHED', '未渲染页被误改动');
    assert.equal(slots[25].style.minHeight, '', '未渲染页被误冻结高度');
    assert.equal(env.api.get('pdfRendered').has(25), false);
  });

  test('E5 已渲染页数未超阈值时不回收任何页', () => {
    const env = loadSandbox();
    setupScroll(env, { rendered: [1,2,3,4,5,6], visible: [3], current: 3 });
    env.api.pdfEvictFarPages();
    assert.equal(env.api.get('pdfRendered').size, 6, '未超阈值不应回收');
  });

  test('E6 单页模式下不执行任何回收', () => {
    const env = loadSandbox();
    setupScroll(env, { rendered: [1,2,3,4,5,6,7,8,9,10], visible: [], current: 5 });
    env.api.set('pdfMode', 'page');
    env.api.pdfEvictFarPages();
    assert.equal(env.api.get('pdfRendered').size, 10);
  });

  test('E7 全部页都可见时不强行回收（宁可占显存也不白屏）', () => {
    const env = loadSandbox();
    const all = Array.from({ length: 12 }, (_, i) => i + 1);
    setupScroll(env, { rendered: all, visible: all, current: 6 });
    env.api.pdfEvictFarPages();
    assert.equal(env.api.get('pdfRendered').size, 12);
  });

  test('E8 slot 缺失（DOM 已重建）时只清账不抛错', () => {
    const env = loadSandbox();
    setupScroll(env, { rendered: [1,2,3,4,5,6,7,8,9,10], visible: [5], current: 5 });
    env.api.set('pdfPageDivs', {});   // DOM 全没了
    assert.doesNotThrow(() => env.api.pdfEvictFarPages());
    assert.equal(env.api.get('pdfRendered').size, env.api.PDF_KEEP_PAGES);
  });

  test('E9 回收后的页重新滚回可视区能重新渲染（走真实 IO 契约：先 pdfVisible.add 再渲染）', async () => {
    const env = loadSandbox({ devicePixelRatio: 2 });
    const slots = setupScroll(env, { rendered: [1,2,3,4,5,6,7,8,9,10,11,12], visible: [6], current: 6 });
    env.api.pdfEvictFarPages();
    const evicted = 12;
    assert.equal(env.api.get('pdfRendered').has(evicted), false, '前置条件：第 12 页已被回收');
    assert.equal(slots[evicted].style.minHeight, '900px', '前置条件：回收时冻结了高度');

    // 复刻 layoutScroll 里 IO 回调的真实顺序（workbench.html L3649）：
    //   if(en.isIntersecting){ pdfVisible.add(p); renderScrollPage(...); }
    env.api.get('pdfVisible').add(evicted);
    env.api.set('pdfCurrentPage', evicted);
    const page = instrument(env, makePage());
    await env.api.renderScrollPage(makeDoc(page), 30, makeContainer(env, 1000), { id: 'b' }, evicted);

    assert.equal(slots[evicted].style.minHeight, '', '重渲染时必须清掉冻结高度，否则新宽度下高度错误');
    assert.ok(env.api.get('pdfRendered').has(evicted));
    const pageDiv = slots[evicted].children[0];
    assert.ok(pageDiv, '重渲染后应产出真实页面 DOM');
    assert.ok(pageDiv.children.some((c) => c.tagName === 'CANVAS'), '重渲染后应有 canvas');
  });

  test('E10 【行为守卫】渲染尾部的自动回收永不吃掉「可见页 / 当前页」', async () => {
    // 背景：renderScrollPage 末尾会调用 pdfEvictFarPages()，理论上可能回收「刚渲染完的这一页」。
    // 真实调用链上该页要么在 pdfVisible（IO 路径），要么总数 ≤ KEEP（relayout 路径），因此不会白页。
    // 本用例把两条路径都钉死，防止未来改动破坏这个前提。
    const env = loadSandbox({ devicePixelRatio: 2 });
    const slots = setupScroll(env, { rendered: [1,2,3,4,5,6,7,8,9,10,11], visible: [13], current: 13 });
    const page = instrument(env, makePage());
    const container = makeContainer(env, 1000);
    // IO 路径：p 已在 pdfVisible 中才渲染
    await env.api.renderScrollPage(makeDoc(page), 30, container, { id: 'b' }, 13);

    const left = env.api.get('pdfRendered');
    assert.ok(left.has(13), '刚渲染完且处于可视区的页被自身触发的回收吃掉 → 会白页');
    assert.ok(slots[13].children[0], '可见页的 DOM 必须保留');
    assert.ok(left.size <= env.api.PDF_KEEP_PAGES + env.api.get('pdfVisible').size,
      `回收后驻留页数异常：${left.size}`);
  });
});

/* ══════════════════════ F. 既有功能未破坏 ══════════════════════ */

describe('F. 既有功能符号与调用链完整性', () => {
  const REQUIRED_FNS = [
    'buildTocDom', 'resolveOutlinePage', 'pdfGoToPage', 'saveBookProgress',
    'setupScrollSpy', 'applyHighlights', 'bindPdfSelection', 'buildTextLayer',
    'highlightTocCurrent', 'loadPdfOutline', 'bindPdfToolbar', 'layoutScroll',
    'updatePdfPageInfo', 'renderPage', 'renderScrollPage',
  ];
  const REQUIRED_CACHE = ['openPdfCacheDB', 'pdfCacheGet', 'pdfCachePut', 'refreshPdfCache'];

  test('F1 PDF 相关函数定义全部存在', () => {
    for (const fn of [...REQUIRED_FNS, ...REQUIRED_CACHE]) {
      assert.match(HTML, new RegExp(`function\\s+${fn}\\s*\\(`), `函数定义丢失：${fn}`);
    }
  });

  test('F2 关键调用链未断（定义之外仍有调用点）', () => {
    const callsites = {
      buildTextLayer: 2, applyHighlights: 2, saveBookProgress: 2,
      setupScrollSpy: 1, bindPdfSelection: 1, highlightTocCurrent: 3,
      pdfGoToPage: 2, resolveOutlinePage: 1, buildTocDom: 2,
      pdfCacheGet: 1, pdfCachePut: 2, refreshPdfCache: 1,
      // pdfRelayout 的 3 个调用点：目录展开/收起、onPdfZoom、onPdfViewportResize
      bindPdfResize: 1, pdfRelayout: 3, pdfContainerWidth: 5, syncPdfScale: 2,
    };
    for (const [fn, min] of Object.entries(callsites)) {
      const total = (HTML.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) || []).length;
      const defs = (HTML.match(new RegExp(`function\\s+${fn}\\s*\\(`, 'g')) || []).length;
      assert.ok(total - defs >= min, `${fn} 调用点不足：期望 ≥${min}，实际 ${total - defs}`);
    }
  });

  test('F3 IndexedDB 缓存路径（秒开）仍然接在渲染入口上', () => {
    assert.match(HTML, /const cached = b && b\.id \? await pdfCacheGet\(b\.id\) : null/);
    assert.match(HTML, /await pdfCachePut\(b\.id, data\)/);
    assert.match(HTML, /refreshPdfCache\(b\.id, source\)/);
  });

  test('F4 滚动模式 IO 预加载边距 400px 未被改动', () => {
    assert.match(HTML, /rootMargin:\s*'400px'/);
    assert.match(HTML, /pdfVisible\.add\(p\)/);
    assert.match(HTML, /pdfVisible\.delete\(p\)/);
  });

  test('F5 pdfGoToPage 在两种模式下都会推进阅读进度', () => {
    const env = loadSandbox();
    env.api.stubRender();
    // 滚动模式
    const slot = env.makeEl('div');
    env.api.set('pdfMode', 'scroll');
    env.api.set('pdfPageDivs', { 8: slot });
    env.api.registerEl('#pdfPageInfo', env.makeEl('div'));
    env.api.pdfGoToPage({}, 50, makeContainer(env, 900), { id: 'bk' }, 8);
    assert.equal(env.api.get('pdfCurrentPage'), 8);
    assert.equal(slot.__scrolledIntoView, 1);
    assert.deepEqual(plain(env.calls.saveBookProgress), [['bk', 8]]);
    // 越界保护
    env.api.pdfGoToPage({}, 50, null, { id: 'bk' }, 999);
    assert.equal(env.api.get('pdfCurrentPage'), 8, '越界页码不应改变当前页');
  });

  test('F6 缩放按钮区间仍为 [0.5, 3]', () => {
    assert.match(HTML, /Math\.min\(3,\s*Math\.round\(\(pdfZoom\+0\.2\)\*100\)\/100\)/);
    assert.match(HTML, /Math\.max\(0\.5,\s*Math\.round\(\(pdfZoom-0\.2\)\*100\)\/100\)/);
  });
});
