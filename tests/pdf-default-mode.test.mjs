/**
 * PDF 默认阅读模式 = 滚动 —— 回归测试
 *
 * 背景：workbench.html 共享状态区把 `let pdfMode='page'` 改为 `let pdfMode='scroll'`。
 * 一行改动，但它是「初始渲染路径 / 工具栏文案 / 容器类名 / 翻页按钮语义」四条链路的总开关。
 *
 * 策略（与 pdf-render.test.mjs 一致）：不重新实现被测逻辑，
 * 而是从 workbench.html 里「按标记抽取真实源码片段」，放进带 DOM mock 的 vm 沙箱里真跑。
 *
 * 覆盖：
 *   G 默认值本身（唯一性 / 双文件一致 / 语法）
 *   H 初始化路径（renderPdfBook 的 scroll/page 分支 + 工具栏模板）
 *   I 模式切换（scroll ⇄ page 往返：状态 / 文案 / 容器类名 / 渲染函数 / 脏状态清理）
 *   J 默认滚动下既有交互未回归（上下页 / 跳转 / 显存回收）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// QA_TARGET_HTML 用于变异测试（对故意注入缺陷的副本跑同一套断言）
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const INDEX = path.join(ROOT, 'index.html');
const HTML = fs.readFileSync(WORKBENCH, 'utf8');

/** 本次改动确立的产品默认值 —— 这里是唯一的「期望值」声明点 */
const EXPECTED_DEFAULT_MODE = 'scroll';

/* ────────────────────────── 源码抽取 ────────────────────────── */

function sliceBetween(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `抽取失败：找不到起始标记 ${label} → ${startMarker}`);
  const b = src.indexOf(endMarker, a);
  assert.notEqual(b, -1, `抽取失败：找不到结束标记 ${label} → ${endMarker}`);
  return src.slice(a, b);
}

// 区块 1：PDF 阅读器共享状态（含被改动的 pdfMode 默认值）
const REGION_STATE = sliceBetween(
  HTML,
  'let pdfDoc=null, pdfTotal=0, pdfScale=1.4;',
  'let _pdfCacheDB=null;',
  'state'
);
// 区块 2：工具栏 + 测宽 / 回收 / 重排 / 渲染 / 滚动布局（bindPdfToolbar → setupScrollSpy 之间是连续源码）
const REGION_TOOLBAR_CORE = sliceBetween(
  HTML,
  'function bindPdfToolbar(doc, total, pagesEl, b){',
  'function setupScrollSpy(',
  'toolbar+core'
);
// 区块 3：renderPdfBook 的首屏渲染分支
const REGION_INIT_BRANCH = sliceBetween(
  HTML,
  '  if(pdfMode === \'scroll\'){',
  '  bindPdfSelection(pagesEl, b);',
  'initBranch'
);
// 区块 4：阅读器骨架模板（工具栏按钮文案 + 容器类名都在这里）
const REGION_SHELL_TPL = (() => {
  // 注意锚点要带 pdf-reader：文件里还有若干个 box.innerHTML = ` 模板（iframe / 纯文本 / 报错兜底）
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

/** 工具栏用到的全部选择器 —— 少一个 bindPdfToolbar 就会 TypeError */
const TOOLBAR_SELECTORS = [
  '#pdfPrev', '#pdfNext', '#pdfTocToggle', '#pdfJump', '#pdfJumpBtn', '#pdfModeBtn',
  '#pdfZoomIn', '#pdfZoomOut', '#pdfZoomVal', '#pdfPageAnno', '#pdfPageInfo', '#pdfToc',
];

/**
 * 构建沙箱：注入 mock 全局 + 真实源码区块（共享状态默认值不做任何覆盖，测的就是它）
 */
function loadSandbox({ devicePixelRatio = 2 } = {}) {
  const calls = {
    render: [], layoutScroll: [], renderPage: [],
    applyAnnos: [], applyHighlights: [], saveBookProgress: [], highlightToc: [],
    observed: [], disconnects: 0, timers: [], resizeListeners: [],
  };

  const body = makeEl('body');
  body.contains = () => true;

  const document = {
    body,
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const origAppend = body.appendChild;
  body.appendChild = (c) => {
    if (c && c.style && /overflow:\s*scroll/.test(c.style.cssText || '')) { c.offsetWidth = 100; c.clientWidth = 100; }
    return origAppend(c);
  };

  const windowObj = {
    devicePixelRatio,
    addEventListener(type, fn) { if (type === 'resize') calls.resizeListeners.push(fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  };

  const sandbox = {
    console, window: windowObj, document,
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px' }),
    setTimeout: (fn, ms) => { const id = calls.timers.length; calls.timers.push({ fn, ms, cleared: false }); return id; },
    clearTimeout: (id) => { if (calls.timers[id]) calls.timers[id].cleared = true; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    IntersectionObserver: class {
      constructor(cb, o) { this.cb = cb; this.opts = o; }
      observe(el) { calls.observed.push(el); }
      disconnect() { calls.disconnects++; }
    },
    Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number, parseFloat, parseInt, isNaN,
    __calls: calls,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const prelude = `
    var __els = {};
    function $(sel){ return __els[sel] || null; }
    function applyAnnos(a,b){ __calls.applyAnnos.push([a,b]); }
    function saveBookProgress(b,n){ __calls.saveBookProgress.push([b&&b.id,n]); }
    function highlightTocCurrent(n){ __calls.highlightToc.push(n); }
    function setupScrollSpy(){}
    function buildTextLayer(){ var d = document.createElement('div'); d.className='textLayer'; return d; }
    function openCogAnno(){}
    function toast(){}
  `;

  // 共享状态区块之后补上区块外仍被引用的游标变量（源码里紧随其后，不属于本次改动范围）
  const stateTail = `
    var pdfCurrentPage = 1;
    var pdfJumpTo = null;
    var _pdfSelBound = false;
  `;

  const epilogue = `
    globalThis.__api = {
      bindPdfToolbar, renderPage, renderScrollPage, layoutScroll, pdfGoToPage,
      pdfEvictFarPages, pdfContainerWidth, PDF_KEEP_PAGES,
      get: (k)=>eval(k),
      set: (k,v)=>{ eval(k+' = v'); },
      registerEl(sel, el){ __els[sel] = el; },
      /** 把 renderPage / layoutScroll 换成探针，只观察「谁被调用」 */
      spyDispatch(){
        renderPage = async function(doc,total,pagesEl,b,n){ __calls.renderPage.push(n); pdfCurrentPage = n; };
        layoutScroll = function(doc,total,pagesEl,b,n){ __calls.layoutScroll.push(n); };
      }
    };
  `;

  vm.runInContext(
    [prelude, REGION_STATE, stateTail, REGION_TOOLBAR_CORE, epilogue].join('\n'),
    sandbox,
    { filename: 'workbench-default-mode.js' }
  );

  const api = sandbox.__api;
  // 工具栏元素全量注册
  const els = {};
  for (const sel of TOOLBAR_SELECTORS) { els[sel] = makeEl('button'); api.registerEl(sel, els[sel]); }

  return { api, calls, els, document, window: windowObj, makeEl };
}

/* ── A4 假 page / doc ── */
const A4_W = 612, A4_H = 792;
function makePage() {
  return {
    getViewport: ({ scale }) => ({ width: A4_W * scale, height: A4_H * scale, scale }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [] }),
  };
}
const makeDoc = (numPages = 20) => ({ numPages, getPage: async () => makePage() });

/** vm 沙箱里的对象来自另一个 realm，deepEqual 会因原型不同而失败 —— 比较前先归一化 */
const plain = (v) => JSON.parse(JSON.stringify(v));

function makeContainer(env, contentWidth = 1000) {
  const el = env.makeEl('div');
  el.clientWidth = contentWidth + 2;
  el.clientHeight = 800;
  el.scrollHeight = 99999;
  return el;
}

/** 渲染真实的阅读器骨架模板，返回 HTML 字符串 */
function renderShell(mode, zoom = 1) {
  const fn = vm.runInNewContext(
    '(function(pdfMode, pdfZoom){ return `' + REGION_SHELL_TPL + '`; })',
    { Math }
  );
  return fn(mode, zoom);
}

/** 执行真实的 renderPdfBook 首屏分支，返回被调用的渲染函数名 */
async function runInitBranch(mode) {
  const hit = [];
  const ctx = {
    pdfMode: mode,
    layoutScroll: (...a) => hit.push(['layoutScroll', a[4]]),
    renderPage: async (...a) => hit.push(['renderPage', a[4]]),
    doc: {}, total: 20, pagesEl: {}, b: { id: 'bk' }, startPage: 7,
  };
  vm.createContext(ctx);
  await vm.runInContext(`(async function(){ ${REGION_INIT_BRANCH} })()`, ctx);
  return hit;
}

/* ══════════════════════ G. 默认值本身 ══════════════════════ */

describe('G. pdfMode 默认值 = scroll', () => {
  test('G1 workbench.html 中 pdfMode 声明唯一，且默认值为 scroll', () => {
    const decls = HTML.match(/let\s+pdfMode\s*=\s*'([^']*)'/g) || [];
    assert.equal(decls.length, 1, `pdfMode 声明应唯一，实际 ${decls.length} 处：${decls}`);
    const value = decls[0].match(/'([^']*)'/)[1];
    assert.equal(value, EXPECTED_DEFAULT_MODE, `默认阅读模式应为 ${EXPECTED_DEFAULT_MODE}，实际 ${value}`);
  });

  test('G2 旧的 let pdfMode=\'page\' 已彻底消失', () => {
    assert.equal((HTML.match(/let\s+pdfMode\s*=\s*'page'/g) || []).length, 0, '仍存在默认单页模式的旧声明');
  });

  test('G3 index.html 与 workbench.html 逐字节一致（默认值同步无遗漏）', () => {
    assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未与 workbench.html 同步');
  });

  test('G4 内联主脚本语法合法（等价 node --check）', () => {
    const m = HTML.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
    assert.ok(m, '未找到内联脚本');
    assert.doesNotThrow(() => new vm.Script(m[1], { filename: 'inline.js' }));
  });

  test('G5 共享状态区块真跑一遍，运行时默认值确实是 scroll（不只是文本匹配）', () => {
    const ctx = { Set };
    vm.createContext(ctx);
    vm.runInContext(REGION_STATE + '\nglobalThis.__mode = pdfMode;', ctx);
    assert.equal(ctx.__mode, EXPECTED_DEFAULT_MODE);
  });

  test('G6 其余共享状态未被误改（本次只应动 pdfMode 一个字面量）', () => {
    const env = loadSandbox();
    assert.equal(env.api.get('pdfDoc'), null);
    assert.equal(env.api.get('pdfTotal'), 0);
    assert.equal(env.api.get('pdfZoom'), 1, '默认缩放仍应为 100%');
    assert.equal(env.api.get('pdfFitScale'), 1.4);
    assert.equal(env.api.get('pdfIO'), null);
    assert.equal(env.api.get('pdfRendered').size, 0);
    assert.equal(env.api.get('pdfVisible').size, 0);
  });
});

/* ══════════════════════ H. 首屏初始化路径 ══════════════════════ */

describe('H. renderPdfBook 首屏走滚动布局', () => {
  test('H1 pdfMode=scroll → 调用 layoutScroll(startPage)，绝不调用 renderPage', async () => {
    const hit = await runInitBranch('scroll');
    assert.deepEqual(hit, [['layoutScroll', 7]], `首屏应走滚动布局，实际 ${JSON.stringify(hit)}`);
  });

  test('H2 pdfMode=page → 回落单页渲染（分支未被写死）', async () => {
    const hit = await runInitBranch('page');
    assert.deepEqual(hit, [['renderPage', 7]], `单页分支被破坏，实际 ${JSON.stringify(hit)}`);
  });

  test('H3 【端到端默认行为】不显式设置模式，直接用源码默认值 → 走 layoutScroll', async () => {
    const ctx = { Set };
    vm.createContext(ctx);
    vm.runInContext(REGION_STATE, ctx);
    const hit = [];
    ctx.layoutScroll = (...a) => hit.push(['layoutScroll', a[4]]);
    ctx.renderPage = async (...a) => hit.push(['renderPage', a[4]]);
    Object.assign(ctx, { doc: {}, total: 20, pagesEl: {}, b: { id: 'bk' }, startPage: 3 });
    await vm.runInContext(`(async function(){ ${REGION_INIT_BRANCH} })()`, ctx);
    assert.deepEqual(hit, [['layoutScroll', 3]], '默认值链路断裂：默认模式没有进入滚动布局');
  });

  test('H4 首屏骨架：滚动模式下容器带 .scroll 类、按钮文案为「📄 单页」', () => {
    const html = renderShell(EXPECTED_DEFAULT_MODE);
    assert.match(html, /class="pdf-pages scroll"/, '滚动模式容器缺少 scroll 类 → CSS 布局会退回单页');
    assert.match(html, /id="pdfModeBtn"[^>]*>📄 单页</, '滚动模式按钮应提示「切到单页」');
    assert.ok(!/>📜 滚动</.test(html), '滚动模式下不应出现「📜 滚动」文案');
  });

  test('H5 首屏骨架：单页模式下无 .scroll 类、按钮文案为「📜 滚动」', () => {
    const html = renderShell('page');
    assert.match(html, /class="pdf-pages"/, '单页模式容器不应带 scroll 类');
    assert.ok(!/class="pdf-pages scroll"/.test(html));
    assert.match(html, /id="pdfModeBtn"[^>]*>📜 滚动</);
  });

  test('H6 按钮文案语义 = 「点了会切到哪个模式」，两种模式互为反向', () => {
    const scrollLabel = renderShell('scroll').match(/id="pdfModeBtn"[^>]*>([^<]*)</)[1];
    const pageLabel = renderShell('page').match(/id="pdfModeBtn"[^>]*>([^<]*)</)[1];
    assert.notEqual(scrollLabel, pageLabel, '两种模式的按钮文案不得相同');
    assert.equal(scrollLabel, '📄 单页');
    assert.equal(pageLabel, '📜 滚动');
  });

  test('H7 骨架其余部分不受默认值影响（缩放、目录、批注按钮仍在）', () => {
    const html = renderShell(EXPECTED_DEFAULT_MODE);
    for (const id of ['pdfToc', 'pdfTocToggle', 'pdfPrev', 'pdfNext', 'pdfJump', 'pdfJumpBtn',
      'pdfZoomOut', 'pdfZoomIn', 'pdfZoomVal', 'pdfPageAnno', 'pdfPages']) {
      assert.match(html, new RegExp(`id="${id}"`), `骨架缺少 #${id}`);
    }
    assert.match(html, />100%</, '缩放初值显示应为 100%');
  });
});

/* ══════════════════════ I. 模式切换往返 ══════════════════════ */

describe('I. 切换按钮 scroll ⇄ page 往返（真跑 bindPdfToolbar）', () => {
  function setupToolbar(env, { total = 20, cw = 1000 } = {}) {
    const pagesEl = makeContainer(env, cw);
    env.api.bindPdfToolbar(makeDoc(total), total, pagesEl, { id: 'bk' });
    return pagesEl;
  }

  test('I1 默认（scroll）点一下 → 切到 page：状态 / 文案 / 容器类名 / 渲染函数 全部同步', async () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    const pagesEl = setupToolbar(env);
    pagesEl.classList.add('scroll');                 // 首屏骨架已加的类
    assert.equal(env.api.get('pdfMode'), 'scroll', '前置条件：初始应为滚动模式');

    env.els['#pdfModeBtn'].onclick();

    assert.equal(env.api.get('pdfMode'), 'page', '点击后未切到单页模式');
    assert.equal(env.els['#pdfModeBtn'].textContent, '📜 滚动', '按钮文案未更新为「📜 滚动」');
    assert.deepEqual(env.calls.renderPage, [1], '应调用 renderPage 重绘当前页');
    assert.deepEqual(env.calls.layoutScroll, [], '切到单页时不应再排滚动布局');
  });

  test('I2 再点一下 → 切回 scroll：文案与渲染函数同步反转', () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    setupToolbar(env);
    env.els['#pdfModeBtn'].onclick();   // scroll → page
    env.els['#pdfModeBtn'].onclick();   // page → scroll

    assert.equal(env.api.get('pdfMode'), 'scroll');
    assert.equal(env.els['#pdfModeBtn'].textContent, '📄 单页');
    assert.deepEqual(env.calls.renderPage, [1]);
    assert.deepEqual(env.calls.layoutScroll, [1], '切回滚动时应重排滚动布局');
  });

  test('I3 切换后按钮文案与「首屏骨架同模式下的文案」完全一致（两处实现不得漂移）', () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    setupToolbar(env);
    env.els['#pdfModeBtn'].onclick();
    assert.equal(env.els['#pdfModeBtn'].textContent,
      renderShell('page').match(/id="pdfModeBtn"[^>]*>([^<]*)</)[1],
      '切换后的文案与首屏模板文案不一致 → 用户会看到两套说法');
    env.els['#pdfModeBtn'].onclick();
    assert.equal(env.els['#pdfModeBtn'].textContent,
      renderShell('scroll').match(/id="pdfModeBtn"[^>]*>([^<]*)</)[1]);
  });

  test('I4 【真渲染】scroll → page：容器 .scroll 类被摘掉，且滚动脏状态被清理', async () => {
    const env = loadSandbox();
    const pagesEl = setupToolbar(env);
    // 先真排一次滚动布局，制造 pdfIO / onscroll / pdfPageDivs 等滚动态
    env.api.layoutScroll(makeDoc(20), 20, pagesEl, { id: 'bk' }, 1);
    pagesEl.onscroll = () => {};
    assert.ok(pagesEl.__classes.has('scroll'), '前置条件：滚动布局应加上 scroll 类');
    assert.ok(env.api.get('pdfIO'), '前置条件：滚动模式应建立 IntersectionObserver');

    env.els['#pdfModeBtn'].onclick();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(env.api.get('pdfMode'), 'page');
    assert.equal(pagesEl.__classes.has('scroll'), false, '切到单页后容器仍带 scroll 类 → 布局错乱');
    assert.equal(env.api.get('pdfIO'), null, 'IntersectionObserver 未断开 → 后台仍在渲染，泄漏显存');
    assert.equal(pagesEl.onscroll, null, '滚动监听未清除');
    assert.equal(Object.keys(env.api.get('pdfPageDivs')).length, 0, '页槽缓存未清空');
    assert.equal(env.api.get('pdfRendered').size, 0);
  });

  test('I5 【真渲染】page → scroll：容器重新加上 .scroll 类并重建全部页槽', () => {
    const env = loadSandbox();
    const pagesEl = setupToolbar(env, { total: 12 });
    env.api.set('pdfMode', 'page');
    pagesEl.classList.remove('scroll');

    env.els['#pdfModeBtn'].onclick();

    assert.equal(env.api.get('pdfMode'), 'scroll');
    assert.ok(pagesEl.__classes.has('scroll'), '切回滚动后容器缺少 scroll 类');
    assert.equal(Object.keys(env.api.get('pdfPageDivs')).length, 12, '应为每一页建立页槽');
    assert.equal(env.calls.observed.length, 12, '每个页槽都应被 IntersectionObserver 观察');
    assert.ok(env.api.get('pdfIO'), '应重建 IntersectionObserver');
  });

  test('I6 往返两次后回到初始滚动态，无残留（幂等）', () => {
    const env = loadSandbox();
    const pagesEl = setupToolbar(env, { total: 8 });
    const before = env.api.get('pdfMode');
    env.els['#pdfModeBtn'].onclick();
    env.els['#pdfModeBtn'].onclick();
    assert.equal(env.api.get('pdfMode'), before);
    assert.ok(pagesEl.__classes.has('scroll'));
    assert.equal(env.els['#pdfModeBtn'].textContent, '📄 单页');
    assert.equal(Object.keys(env.api.get('pdfPageDivs')).length, 8);
  });

  test('I7 切换时保持当前页码不丢（从第 5 页切模式仍在第 5 页）', () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    setupToolbar(env);
    env.api.set('pdfCurrentPage', 5);
    env.els['#pdfModeBtn'].onclick();
    assert.deepEqual(env.calls.renderPage, [5], '切到单页时应重绘当前页而不是第 1 页');
    env.els['#pdfModeBtn'].onclick();
    assert.deepEqual(env.calls.layoutScroll, [5], '切回滚动时应定位到当前页');
  });
});

/* ══════════════════════ J. 默认滚动下的既有交互 ══════════════════════ */

describe('J. 默认滚动模式下既有交互未回归', () => {
  test('J1 上一页 / 下一页走 scrollIntoView，而不是重绘单页', () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    const pagesEl = makeContainer(env);
    env.api.bindPdfToolbar(makeDoc(20), 20, pagesEl, { id: 'bk' });
    const slots = {};
    for (let i = 1; i <= 20; i++) slots[i] = env.makeEl('div');
    env.api.set('pdfPageDivs', slots);
    env.api.set('pdfCurrentPage', 5);

    env.els['#pdfNext'].onclick();
    assert.equal(slots[6].__scrolledIntoView, 1, '下一页应滚动到第 6 页');
    env.els['#pdfPrev'].onclick();
    assert.equal(slots[4].__scrolledIntoView, 1, '上一页应滚动到第 4 页');
    assert.deepEqual(env.calls.renderPage, [], '滚动模式不应触发单页重绘');
  });

  test('J2 首页/末页边界不越界', () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    env.api.bindPdfToolbar(makeDoc(3), 3, makeContainer(env), { id: 'bk' });
    const slots = {};
    for (let i = 1; i <= 3; i++) slots[i] = env.makeEl('div');
    env.api.set('pdfPageDivs', slots);

    env.api.set('pdfCurrentPage', 1);
    env.els['#pdfPrev'].onclick();
    assert.equal(slots[1].__scrolledIntoView, 1, '首页上一页应停在第 1 页');
    env.api.set('pdfCurrentPage', 3);
    env.els['#pdfNext'].onclick();
    assert.equal(slots[3].__scrolledIntoView, 1, '末页下一页应停在第 3 页');
  });

  test('J3 跳转按钮在滚动模式下滚动到目标页并保存进度', () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    env.api.bindPdfToolbar(makeDoc(30), 30, makeContainer(env), { id: 'bk' });
    const slots = {};
    for (let i = 1; i <= 30; i++) slots[i] = env.makeEl('div');
    env.api.set('pdfPageDivs', slots);
    env.els['#pdfJump'].value = '17';

    env.els['#pdfJumpBtn'].onclick();

    assert.equal(env.api.get('pdfCurrentPage'), 17);
    assert.equal(slots[17].__scrolledIntoView, 1);
    assert.equal(env.els['#pdfPageInfo'].textContent, '第 17 / 30 页');
    assert.deepEqual(plain(env.calls.saveBookProgress), [['bk', 17]]);
  });

  test('J4 默认滚动 → 显存回收路径默认启用（此前默认单页时该路径不生效）', () => {
    const env = loadSandbox();
    const slots = {};
    for (let i = 1; i <= 30; i++) { const s = env.makeEl('div'); s.offsetHeight = 900; slots[i] = s; }
    env.api.set('pdfPageDivs', slots);
    env.api.set('pdfRendered', new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    env.api.set('pdfVisible', new Set([6]));
    env.api.set('pdfCurrentPage', 6);

    env.api.pdfEvictFarPages();   // 未显式设置模式，吃的就是源码默认值

    assert.equal(env.api.get('pdfRendered').size, env.api.PDF_KEEP_PAGES,
      '默认滚动下回收未生效 → 长文档会持续堆积高清 canvas');
    assert.ok(env.api.get('pdfRendered').has(6), '当前页不得被回收');
  });

  test('J5 缩放按钮在默认滚动模式下重排已渲染页（不退回单页渲染）', async () => {
    const env = loadSandbox();
    env.api.spyDispatch();
    const pagesEl = makeContainer(env);
    env.api.bindPdfToolbar(makeDoc(20), 20, pagesEl, { id: 'bk' });
    const slots = {};
    for (let i = 1; i <= 20; i++) slots[i] = env.makeEl('div');
    env.api.set('pdfPageDivs', slots);
    env.api.set('pdfRendered', new Set([4, 5]));
    env.api.set('pdfCurrentPage', 5);

    env.els['#pdfZoomIn'].onclick();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(env.api.get('pdfZoom'), 1.2);
    assert.equal(env.els['#pdfZoomVal'].textContent, '120%');
    assert.deepEqual(env.calls.renderPage, [], '滚动模式缩放不应走单页渲染');
  });
});
