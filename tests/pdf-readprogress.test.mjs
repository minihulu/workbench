/**
 * PDF 续读进度（lastPage）—— pdfSuppressSave 竞态修复回归测试
 *
 * ─────────────────────────── 被修复的 Bug ───────────────────────────
 * 打开一本 PDF 书时，renderPdfBook 会把 pdfCurrentPage 设为 b.lastPage（续读页），
 * 然后在滚动模式下由 layoutScroll 的 rAF 里 scrollIntoView() 程序化滚到该页。
 * 但 setupScrollSpy 注册的 onscroll 会在「程序滚动尚未 settle」时被触发：
 * 此刻 DOM 量出来的可视页仍是第 1 页 → cur(1) !== pdfCurrentPage(50) →
 * 走进 if 分支调用 saveBookProgress(b, 1)，把 b.lastPage 从 50 覆写成 1。
 * 结果：每次打开书都被重置到第 1 页，续读失效，且脏值会同步到云端。
 *
 * 修复：新增模块级开关 pdfSuppressSave，restore 期间置 true，
 *      saveBookProgress 在最前面 early-return，restore settle（600ms）后放开。
 *
 * ─────────────────────────── 测试策略 ───────────────────────────
 * 与 pdf-render / pdf-default-mode / pdf-anno-sidebar 一致：**不重新实现被测逻辑**，
 * 而是从 workbench.html 按标记抽取真实源码片段，丢进带 mini-DOM 的 vm 沙箱里真跑。
 * 断言的是线上代码本身 —— 谁把 pdfSuppressSave 删了 / 挪位置了 / 忘了清，测试立刻红。
 *
 * 覆盖：
 *   A 静态不变量（声明唯一 / 五处接线 / 守卫位置 / 双文件一致）
 *   B saveBookProgress 守卫语义（true 早退无副作用 / false 正常落盘）
 *   C 核心回归：restore 期间 scrollSpy 不得把 lastPage 覆写回 1
 *   D 正常阅读路径不受影响（守卫放开后照常保存）
 *   E 守卫的生命周期（600ms 后自动放开，两处清除点都有效）
 *   F 端到端：lastPage=50 的书在滚动模式下开卷 → startPage=50 且进度不被冲掉
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

/* ══════════════════════════ 源码抽取 ══════════════════════════ */

function sliceBetween(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `抽取失败：找不到起始标记 ${label} → ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.notEqual(b, -1, `抽取失败：找不到结束标记 ${label} → ${endMarker}`);
  return src.slice(a, b);
}

/** 阅读器共享状态：pdfDoc / pdfTotal / pdfMode / pdfPageDivs / pdfRendered / pdfVisible … */
const R_STATE = sliceBetween(
  HTML, 'let pdfDoc=null, pdfTotal=0, pdfScale=1.4;', 'let _pdfCacheDB=null;', 'state');
/** 游标状态：pdfCurrentPage / pdfJumpTo / pdfAnnoFilter / _pdfSelBound / **pdfSuppressSave** */
const R_CURSOR = sliceBetween(
  HTML, 'let pdfCurrentPage = 1;', 'async function renderPdfBook(', 'cursor');
/** renderPdfBook 的 restore 段：startPage 计算 → 置 pdfSuppressSave → 首屏分支 → 600ms 兜底清除 */
const R_RESTORE = sliceBetween(
  HTML, '  const startPage = Math.min(', '  bindPdfSelection(pagesEl, b);', 'restore');
/** bindPdfToolbar：#pdfModeBtn 切换单页/滚动 —— 同一竞态的第二个触发口 */
const R_TOOLBAR = sliceBetween(
  HTML, 'function bindPdfToolbar(doc, total, pagesEl, b){', '/* === 自适应：阅读容器可用宽度', 'toolbar');
/** layoutScroll：建页槽 + IO + setupScrollSpy + rAF 里 scrollIntoView & 清除守卫 */
const R_LAYOUT = sliceBetween(
  HTML, 'function layoutScroll(doc, total, pagesEl, b, startPage){', 'async function renderScrollPage(', 'layoutScroll');
/** setupScrollSpy：onscroll → rAF → 量各页 top 求当前页 → saveBookProgress（bug 现场） */
const R_SPY = sliceBetween(
  HTML, 'function setupScrollSpy(doc, total, pagesEl, b){', '/* PDF 大纲', 'scrollSpy');
/** saveBookProgress：**守卫所在处** + debounce 落盘/同步 */
const R_SAVE = sliceBetween(
  HTML, 'let _lastPageSaveT = null;', 'function saveCogProgress(){', 'saveBookProgress');

// 抽取边界自检：区块必须真的含被测函数，否则「真跑」跑了个寂寞
assert.ok(R_CURSOR.includes('pdfSuppressSave'), '游标区块缺少 pdfSuppressSave 声明（抽取边界漂移？）');
assert.ok(R_LAYOUT.includes('function layoutScroll'), 'layoutScroll 区块抽取异常');
assert.ok(R_SPY.includes('pagesEl.onscroll'), 'scrollSpy 区块抽取异常');
assert.ok(R_SAVE.includes('function saveBookProgress(b, n){'), 'saveBookProgress 区块抽取异常');
assert.ok(R_RESTORE.includes('pdfSuppressSave = true'), 'restore 区块缺少置位语句');
assert.ok(R_TOOLBAR.includes('$("#pdfModeBtn").onclick'), 'toolbar 区块缺少 #pdfModeBtn 处理器（抽取边界漂移？）');

/* ══════════════════════════ mini-DOM ══════════════════════════ */

/**
 * 页槽元素：核心是 `__top`（可写的 getBoundingClientRect().top），
 * scrollSpy 就是靠它算「当前可视页」的，测试通过改 __top 来模拟滚动位置。
 */
function makeEl(tag, doc) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    dataset: {},
    style: { cssText: '', width: '', height: '', minHeight: '' },
    children: [],
    parentNode: null,
    textContent: '',
    clientWidth: 800, clientHeight: 600, scrollHeight: 99999,
    offsetWidth: 800, offsetHeight: 600,
    onscroll: null,
    _html: '',
    __top: 0,                 // ← 测试可写：模拟该元素在视口中的纵向位置
    __scrolledIntoView: 0,
    getContext: () => ({ drawImage() {}, clearRect() {} }),
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    scrollIntoView() { el.__scrolledIntoView++; },
    getBoundingClientRect: () => ({ top: el.__top, left: 0, bottom: el.__top + 100, right: 800, width: 800, height: 100 }),
    querySelector: () => null,
    querySelectorAll: () => [],
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

/* ══════════════════════════ 沙箱 ══════════════════════════ */

/**
 * @param {object} opts
 *   opts.mode      'scroll' | 'page'
 *   opts.total     总页数
 *   opts.mutate    (src)=>src 源码变异钩子，用于反证「去掉守卫后 Bug 确实复现」
 */
function loadSandbox(opts = {}) {
  const { mode = 'scroll', total = 100, mutate = null } = opts;

  const calls = {
    persistCog: [],       // ← 落盘 spy
    scheduleSync: [],     // ← 云同步 spy
    highlightToc: [],
    pageInfo: [],
    applyAnnos: [],
    renderPage: [],
    layoutScroll: [],
    goToPage: [],
    timers: [],           // {fn, ms, cleared}
  };

  const document = {
    createElement: (t) => makeEl(t, document),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  document.body = makeEl('body', document);
  document.body.contains = () => true;

  const windowObj = {
    devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  };

  const sandbox = {
    console, window: windowObj, document,
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px' }),
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms, cleared: false }); return calls.timers.length - 1; },
    clearTimeout: (id) => { if (calls.timers[id]) calls.timers[id].cleared = true; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    IntersectionObserver: class { constructor(cb, o) { this.cb = cb; this.opts = o; } observe() {} disconnect() {} },
    Math, JSON, Date, Set, Map, Object, Array, Promise, Error, String, Number,
    parseFloat, parseInt, isNaN, Infinity, NaN,
    __calls: calls,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const prelude = `
    var __els = {};
    function $(sel){ return __els[sel] || null; }
    // ── 落盘 / 同步：spy，用来断言「守卫开着时一次都不许调」 ──
    function persistCog(){ __calls.persistCog.push(1); }
    function scheduleSync(){ __calls.scheduleSync.push(1); }
    // ── 其余外部依赖：桩 ──
    function highlightTocCurrent(n){ __calls.highlightToc.push(n); }
    function updatePdfPageInfo(t){ __calls.pageInfo.push(pdfCurrentPage); }
    function applyAnnos(a,b){ __calls.applyAnnos.push([a,b]); }
    function renderScrollPage(){}
    function pdfEvictFarPages(){}
    function bindPdfResize(){}
    function loadPdfOutline(){}
    function bindPdfAnnoSidebar(){}
    function bindPdfSelection(){}
    function toast(){}
    var cogBooks = [];
    // ── bindPdfToolbar 的区块外依赖（本文件不测缩放/重排，只测 #pdfModeBtn 分支）──
    var _pdfLastW = 0;
    function pdfContainerWidth(){ return 800; }
    function pdfRelayout(){}
    function onPdfZoom(){}
    function pdfGoToPage(doc,total,pagesEl,b,n){ __calls.goToPage.push(n); saveBookProgress(b,n); }
    function openAnnoEditor(){}
  `;

  // pdfSuppressSave / pdfCurrentPage / _lastPageSaveT 都是 let（词法绑定，拿不到全局属性），
  // 用同作用域的 eval 桥出读写能力 —— 不改源码文本，测的仍是线上那一份
  const epilogue = `
    globalThis.__api = {
      layoutScroll, setupScrollSpy, saveBookProgress, bindPdfToolbar,
      get: (k)=>eval(k),
      set: (k,v)=>{ eval(k+' = v'); },
      registerEl(sel, el){ __els[sel] = el; },
      /** 真实的 renderPdfBook restore 段（startPage 计算 → 置守卫 → 首屏 → 600ms 兜底） */
      async runRestore(doc, total, b){
        pdfTotal = total;
        ${R_RESTORE}
        return startPage;
      },
      renderPage: async function(doc,total,pagesEl,b,n){ __calls.renderPage.push(n); pdfCurrentPage=n; saveBookProgress(b,n); },
    };
    // renderPdfBook 单页分支调用的是 renderPage，桥到上面那个探针
    var renderPage = globalThis.__api.renderPage;
  `;

  // 变异钩子只作用于「被测源码」，不碰 prelude/epilogue 的桩，保证反证场景干净
  let realSrc = [R_STATE, R_CURSOR, R_TOOLBAR, R_LAYOUT, R_SPY, R_SAVE].join('\n');
  if (mutate) {
    const before = realSrc;
    realSrc = mutate(realSrc);
    assert.notEqual(realSrc, before, '变异钩子没命中任何源码 —— 反证用例会假通过，请检查锚点');
  }

  vm.runInContext(
    [prelude, realSrc, epilogue].join('\n'),
    sandbox,
    { filename: 'workbench-readprogress.js' }
  );

  const api = sandbox.__api;
  api.set('pdfMode', mode);
  api.set('pdfTotal', total);
  // 现在沙箱里跑的是**真实** bindPdfToolbar（renderPdfBook 会调它），缺元素就 TypeError；
  // 真实 DOM 里这些按钮本来就都在，默认全量注册更贴近线上（测试可再覆盖同名选择器）
  for (const sel of TOOLBAR_SELECTORS) api.registerEl(sel, makeEl('button', document));

  return {
    api, calls, document, window: windowObj, sandbox,
    makeEl: (t) => makeEl(t, document),
    /** 跑完当前排队且未被 clearTimeout 的定时器（回调里新排的留到下一次 flush） */
    flushTimers(filter) {
      const batch = calls.timers.map((t, i) => ({ ...t, i })).filter((t) => !t.cleared && (!filter || filter(t)));
      batch.forEach((t) => { calls.timers[t.i].cleared = true; });
      batch.forEach((t) => t.fn());
      return batch.length;
    },
  };
}

/** 造一本书 */
const mkBook = (o = {}) => ({ id: o.id || 'bk1', title: o.title || '测试书', lastPage: o.lastPage === undefined ? 50 : o.lastPage, ...o });

/** 造 pdf doc */
const makeDoc = (numPages = 100) => ({ numPages, getPage: async () => ({}) });

/**
 * 建一个页容器 + total 个页槽，并按「当前可视页 = visible」摆好各页 top。
 * 规则：slot[i].top = (i - visible) * 100 → i<=visible 的 top<=0，i=visible 时 -top 最小 → cur=visible
 */
function mountPages(env, total, visible) {
  const pagesEl = env.makeEl('div');
  pagesEl.__top = 0;
  env.api.registerEl('#pdfPages', pagesEl);
  const divs = {};
  for (let i = 1; i <= total; i++) {
    const s = env.makeEl('div');
    s.dataset.page = i;
    s.__top = (i - visible) * 100;
    divs[i] = s;
  }
  env.api.set('pdfPageDivs', divs);
  return { pagesEl, divs };
}

/** 把「DOM 认为的可视页」挪到 page（改各页槽 top） */
function setVisiblePage(divs, total, page) {
  for (let i = 1; i <= total; i++) divs[i].__top = (i - page) * 100;
}

/** bindPdfToolbar 会 $() 到的全部选择器 —— 少一个就 TypeError */
const TOOLBAR_SELECTORS = [
  '#pdfPrev', '#pdfNext', '#pdfTocToggle', '#pdfJump', '#pdfJumpBtn', '#pdfModeBtn',
  '#pdfZoomIn', '#pdfZoomOut', '#pdfZoomVal', '#pdfPageAnno', '#pdfPageInfo', '#pdfToc',
  '#pdfFullBtn',  // 全屏阅读按钮：bindPdfToolbar 末尾绑定其 onclick，沙箱须注册，否则 null.onclick 抛错
];

/* ══════════════════════ A 静态不变量 ══════════════════════ */

describe('A. pdfSuppressSave 接线（静态）', () => {
  test('A1 pdfSuppressSave 声明唯一，初值 false，且在游标状态区', () => {
    const decls = HTML.match(/^\s*(?:let|var|const)\s+pdfSuppressSave\b[^\n]*/gm) || [];
    assert.equal(decls.length, 1, `pdfSuppressSave 声明应恰好 1 处，实际 ${decls.length} 处：${JSON.stringify(decls)}`);
    assert.match(decls[0], /=\s*false\s*;/, '初值必须是 false —— 若默认 true，首次保存会被永久吞掉');
    assert.ok(R_CURSOR.includes(decls[0].trim()), '声明不在 pdfCurrentPage/pdfJumpTo 那一段状态区（位置漂移）');
  });

  test('A2 六处接线齐全：1 声明 / 2 置位 / 2 清除 / 1 守卫', () => {
    const all = HTML.match(/pdfSuppressSave/g) || [];
    assert.equal(all.length, 6, `pdfSuppressSave 出现次数应为 6，实际 ${all.length}（接线被增删？）`);
    // 两个置位点：renderPdfBook 开卷 restore + bindPdfToolbar 切到滚动模式
    assert.equal((HTML.match(/pdfSuppressSave\s*=\s*true/g) || []).length, 2,
      '置位点应恰好 2 处（renderPdfBook 开卷 + #pdfModeBtn 切滚动）—— 两个触发口都得上锁');
    assert.equal((R_RESTORE.match(/pdfSuppressSave\s*=\s*true/g) || []).length, 1, 'renderPdfBook 置位缺失/重复');
    assert.equal((R_TOOLBAR.match(/pdfSuppressSave\s*=\s*true/g) || []).length, 1, '#pdfModeBtn 置位缺失/重复');
    // 声明本身也是 `= false`，先摘掉再数，否则会把声明误计为清除点
    const noDecl = HTML.replace(/^\s*(?:let|var|const)\s+pdfSuppressSave\b[^\n]*/m, '');
    assert.equal((noDecl.match(/pdfSuppressSave\s*=\s*false/g) || []).length, 2,
      '清除点应恰好 2 处（renderPdfBook 兜底 + layoutScroll 的 rAF）—— 少一处会导致守卫永久卡死');
    assert.equal((R_RESTORE.match(/pdfSuppressSave\s*=\s*false/g) || []).length, 1, 'renderPdfBook 兜底清除缺失/重复');
    assert.equal((R_LAYOUT.match(/pdfSuppressSave\s*=\s*false/g) || []).length, 1, 'layoutScroll rAF 清除缺失/重复');
    assert.equal((HTML.match(/if\s*\(\s*pdfSuppressSave\s*\)\s*return/g) || []).length, 1, '守卫 early-return 应恰好 1 处');
    // 切模式复用 layoutScroll 的 rAF 解锁，不该自带清除点（多一个会提前解锁）
    assert.equal((R_TOOLBAR.match(/pdfSuppressSave\s*=\s*false/g) || []).length, 0,
      '#pdfModeBtn 不应自带解锁 —— 解锁应由 layoutScroll 的 rAF 统一负责');
  });

  test('A3 守卫在 saveBookProgress 内、且早于任何 b.lastPage 写入', () => {
    const guardAt = R_SAVE.indexOf('if(pdfSuppressSave) return');
    const writeAt = R_SAVE.indexOf('b.lastPage = n');
    const nullAt = R_SAVE.indexOf('if(!b) return');
    assert.notEqual(guardAt, -1, 'saveBookProgress 里找不到 pdfSuppressSave 守卫');
    assert.notEqual(writeAt, -1, 'saveBookProgress 里找不到 b.lastPage 写入');
    assert.ok(guardAt < writeAt, '守卫必须在 b.lastPage 写入之前，否则脏值照样落到内存对象上');
    assert.ok(nullAt !== -1 && nullAt < guardAt, '守卫应紧随 if(!b) return 之后');
    // 守卫也必须早于 debounce 的 persistCog/scheduleSync 排期
    assert.ok(guardAt < R_SAVE.indexOf('persistCog()'), '守卫必须早于落盘排期');
  });

  test('A4 置位点在 renderPdfBook 里紧随 pdfCurrentPage = startPage', () => {
    const setAt = R_RESTORE.indexOf('pdfSuppressSave = true');
    const curAt = R_RESTORE.indexOf('pdfCurrentPage = startPage');
    assert.ok(curAt !== -1 && setAt !== -1, 'restore 段缺少 pdfCurrentPage=startPage 或 pdfSuppressSave=true');
    assert.ok(curAt < setAt, '应先定住 pdfCurrentPage 再上锁');
    // 上锁必须早于首屏渲染分支，否则 scrollSpy 已经能写脏值了
    assert.ok(setAt < R_RESTORE.indexOf("if(pdfMode === 'scroll')"), '上锁必须早于首屏渲染分支');
  });

  test('A5 两处清除点分别在 renderPdfBook 兜底与 layoutScroll 的 rAF 内，均为 600ms', () => {
    assert.match(R_RESTORE, /setTimeout\(\s*\(\)\s*=>\s*\{\s*pdfSuppressSave\s*=\s*false;?\s*\}\s*,\s*600\s*\)/,
      'renderPdfBook 缺少 600ms 兜底清除（单页模式会永久卡住守卫）');
    assert.match(R_LAYOUT, /requestAnimationFrame\([\s\S]*scrollIntoView\(\)[\s\S]*pdfSuppressSave\s*=\s*false[\s\S]*\)/,
      'layoutScroll 的 rAF 内缺少「程序滚动后清除守卫」');
    // 清除必须排在 scrollIntoView 之后，否则程序滚动触发的 onscroll 又能写脏值
    const rafSeg = R_LAYOUT.slice(R_LAYOUT.indexOf('requestAnimationFrame('));
    assert.ok(rafSeg.indexOf('scrollIntoView()') < rafSeg.indexOf('pdfSuppressSave = false'),
      '守卫必须在 scrollIntoView() 之后才清除');
  });

  test('A6 抽取到的源码语法可解析（防止改动引入括号不平衡）', () => {
    assert.doesNotThrow(
      () => new vm.Script([R_LAYOUT, R_SPY, R_SAVE].join('\n'), { filename: 'syntax-check.js' }),
      '被测源码区块存在语法错误');
  });

  test('A7 workbench.html 与 index.html 完全一致（修复必须双份同步）', () => {
    const idx = fs.readFileSync(INDEX, 'utf8');
    assert.equal((idx.match(/pdfSuppressSave/g) || []).length, 6, 'index.html 未同步 pdfSuppressSave 修复');
    if (!process.env.QA_TARGET_HTML) {
      assert.equal(idx, fs.readFileSync(path.join(ROOT, 'workbench.html'), 'utf8'), '两份 HTML 不一致');
    }
  });
});

/* ══════════════════════ B 守卫语义 ══════════════════════ */

describe('B. saveBookProgress 守卫语义', () => {
  test('B1 守卫开启：不写 lastPage / 不改 progress / 不排落盘', () => {
    const env = loadSandbox();
    const b = mkBook({ lastPage: 50, progress: 45, totalPages: 100, lastReadAt: 111, updatedAt: 111 });
    env.api.set('pdfSuppressSave', true);

    env.api.saveBookProgress(b, 1);

    assert.equal(b.lastPage, 50, '守卫开启时 lastPage 被改写了 —— 这正是原 Bug');
    assert.equal(b.progress, 45, '守卫开启时 progress 不应被重算');
    assert.equal(b.lastReadAt, 111, '守卫开启时 lastReadAt 不应被刷新');
    assert.equal(b.updatedAt, 111, '守卫开启时 updatedAt 不应被刷新（否则会赢下同步的 LWW 比较）');
    env.flushTimers();
    assert.deepEqual(env.calls.persistCog, [], '守卫开启时不得落盘');
    assert.deepEqual(env.calls.scheduleSync, [], '守卫开启时不得触发云同步 —— 否则脏值会污染其他设备');
  });

  test('B2 守卫关闭：lastPage 落位 + progress 自动重算 + 落盘/同步被调用', () => {
    const env = loadSandbox({ total: 100 });
    const b = mkBook({ lastPage: 1 });
    env.api.set('pdfSuppressSave', false);

    env.api.saveBookProgress(b, 50);

    assert.equal(b.lastPage, 50, '守卫关闭时应正常写入 lastPage');
    assert.equal(b.totalPages, 100, '应补写 totalPages');
    assert.equal(b.progress, 50, '50/100 → progress 应为 50');
    assert.equal(b.progressAuto, true, 'PDF 书进度应标记为自动');
    assert.ok(b.lastReadAt > 0 && b.updatedAt > 0, '应刷新时间戳');

    // 落盘是 400ms debounce，flush 前不该有；flush 后必须有
    assert.deepEqual(env.calls.persistCog, [], '落盘应走 400ms debounce，不能同步执行');
    env.flushTimers();
    assert.deepEqual(env.calls.persistCog, [1], '守卫关闭时应落盘 1 次');
    assert.deepEqual(env.calls.scheduleSync, [1], '守卫关闭时应触发云同步 1 次');
  });

  test('B3 守卫不吃掉 if(!b) return（空书仍安全空转）', () => {
    const env = loadSandbox();
    env.api.set('pdfSuppressSave', false);
    assert.doesNotThrow(() => env.api.saveBookProgress(null, 5));
    assert.doesNotThrow(() => env.api.saveBookProgress(undefined, 5));
    env.flushTimers();
    assert.deepEqual(env.calls.persistCog, [], '空书不应落盘');
  });

  test('B4 守卫是「拦截」不是「延后」：抑制期的保存不会在放开后补写', () => {
    const env = loadSandbox({ total: 100 });
    const b = mkBook({ lastPage: 50 });
    env.api.set('pdfSuppressSave', true);
    env.api.saveBookProgress(b, 1);      // 被吞
    env.api.set('pdfSuppressSave', false);
    env.flushTimers();                    // 放开后把所有排队定时器跑完
    assert.equal(b.lastPage, 50, '被抑制的那次保存不得在放开后借 debounce 补写回来');
    assert.deepEqual(env.calls.persistCog, [], '被抑制的保存不该留下任何落盘排期');
  });
});

/* ══════════════════════ C 核心回归：restore 竞态 ══════════════════════ */

describe('C. 【核心回归】restore 期间 scrollSpy 不得把 lastPage 覆写回 1', () => {
  /** 装配：滚动模式 + 100 页 + 真实 setupScrollSpy，模拟「已 restore 到第 50 页」 */
  function mountRestored(env, { total = 100, startPage = 50, suppress = true } = {}) {
    const { pagesEl, divs } = mountPages(env, total, startPage);
    const b = mkBook({ lastPage: startPage });
    env.api.set('pdfCurrentPage', startPage);      // renderPdfBook 已把游标定在续读页
    env.api.set('pdfSuppressSave', suppress);
    env.api.setupScrollSpy(makeDoc(total), total, pagesEl, b);
    return { pagesEl, divs, b, total };
  }

  test('C1 守卫开启 + DOM 仍报第 1 页 → lastPage 保持 50（Bug 现场）', () => {
    const env = loadSandbox();
    const { pagesEl, divs, b, total } = mountRestored(env);

    // 程序滚动尚未 settle：DOM 量出来的可视页还是第 1 页
    setVisiblePage(divs, total, 1);
    pagesEl.onscroll();

    assert.equal(b.lastPage, 50, `原 Bug 复现：restore 期间 scrollSpy 把 lastPage 覆写成了 ${b.lastPage}`);
    env.flushTimers();
    assert.deepEqual(env.calls.persistCog, [], 'restore 期间不得落盘');
    assert.deepEqual(env.calls.scheduleSync, [], 'restore 期间不得同步 —— 否则第 1 页会被推到云端');
  });

  test('C2 守卫关闭（模拟修复前）时同一场景确实会被覆写 —— 证明用例有杀伤力', () => {
    const env = loadSandbox();
    const { pagesEl, divs, b, total } = mountRestored(env, { suppress: false });

    setVisiblePage(divs, total, 1);
    pagesEl.onscroll();

    assert.equal(b.lastPage, 1,
      '把守卫关掉后 lastPage 应被覆写成 1；若这里没被覆写，说明 C1 是假通过（场景没真正命中 Bug 路径）');
  });

  test('C3 restore 期间连续多次抖动滚动，lastPage 依然纹丝不动', () => {
    const env = loadSandbox();
    const { pagesEl, divs, b, total } = mountRestored(env);

    for (const p of [1, 2, 1, 3, 1, 7, 1]) {
      setVisiblePage(divs, total, p);
      pagesEl.onscroll();
    }

    assert.equal(b.lastPage, 50, 'restore 期间的任何抖动都不该动 lastPage');
    env.flushTimers();
    assert.deepEqual(env.calls.scheduleSync, [], 'restore 抖动不得产生同步');
  });

  test('C4 守卫开启时 saveBookProgress 一次都没能写进去（三个 saveBookProgress 调用点统一生效）', () => {
    const env = loadSandbox();
    const b = mkBook({ lastPage: 50 });
    env.api.set('pdfSuppressSave', true);
    // 分别模拟 pdfGoToPage / renderPage / setupScrollSpy 三处调用点
    env.api.saveBookProgress(b, 1);
    env.api.saveBookProgress(b, 2);
    env.api.saveBookProgress(b, 3);
    assert.equal(b.lastPage, 50, '守卫应对所有调用点一视同仁');
  });
});

/* ══════════════════════ D 正常阅读不受影响 ══════════════════════ */

describe('D. 正常阅读路径不被守卫误伤', () => {
  test('D1 守卫关闭 + 滚到第 30 页 → lastPage 更新为 30 并落盘', () => {
    const env = loadSandbox();
    const total = 100;
    const { pagesEl, divs } = mountPages(env, total, 50);
    const b = mkBook({ lastPage: 50 });
    env.api.set('pdfCurrentPage', 50);
    env.api.set('pdfSuppressSave', false);         // restore 已结束
    env.api.setupScrollSpy(makeDoc(total), total, pagesEl, b);

    setVisiblePage(divs, total, 30);
    pagesEl.onscroll();

    assert.equal(b.lastPage, 30, '正常阅读时 scrollSpy 应把 lastPage 更新到当前页');
    assert.equal(env.api.get('pdfCurrentPage'), 30, 'pdfCurrentPage 应同步到 30');
    env.flushTimers();
    assert.deepEqual(env.calls.persistCog, [1], '正常阅读应落盘');
    assert.deepEqual(env.calls.scheduleSync, [1], '正常阅读应同步');
  });

  test('D2 顺序阅读 50 → 51 → 52，每一页都被记录，最终停在 52', () => {
    const env = loadSandbox();
    const total = 100;
    const { pagesEl, divs } = mountPages(env, total, 50);
    const b = mkBook({ lastPage: 50 });
    env.api.set('pdfCurrentPage', 50);
    env.api.set('pdfSuppressSave', false);
    env.api.setupScrollSpy(makeDoc(total), total, pagesEl, b);

    for (const p of [51, 52]) { setVisiblePage(divs, total, p); pagesEl.onscroll(); }

    assert.equal(b.lastPage, 52);
    assert.equal(b.progress, 52, '52/100 → 52%');
    // debounce：多次保存只应留下最后一个未被 clearTimeout 的落盘排期
    const live = env.calls.timers.filter((t) => !t.cleared && t.ms === 400);
    assert.equal(live.length, 1, `400ms 落盘定时器应被 debounce 合并为 1 个，实际 ${live.length}`);
  });

  test('D3 停在同一页反复 onscroll 不产生冗余保存（cur === pdfCurrentPage 短路）', () => {
    const env = loadSandbox();
    const total = 100;
    const { pagesEl, divs } = mountPages(env, total, 30);
    const b = mkBook({ lastPage: 30 });
    env.api.set('pdfCurrentPage', 30);
    env.api.set('pdfSuppressSave', false);
    env.api.setupScrollSpy(makeDoc(total), total, pagesEl, b);

    pagesEl.onscroll(); pagesEl.onscroll(); pagesEl.onscroll();

    assert.deepEqual(env.calls.timers.filter((t) => t.ms === 400), [], '同页重复滚动不应排任何落盘');
  });
});

/* ══════════════════════ E 守卫生命周期 ══════════════════════ */

describe('E. 守卫会被可靠放开（不会永久卡死）', () => {
  test('E1 layoutScroll 的 rAF 排了一个 600ms 清除定时器，跑完后守卫关闭', () => {
    const env = loadSandbox();
    const total = 20;
    const pagesEl = env.makeEl('div');
    env.api.set('pdfSuppressSave', true);

    env.api.layoutScroll(makeDoc(total), total, pagesEl, mkBook(), 12);

    assert.equal(env.api.get('pdfSuppressSave'), true, 'rAF 内 scrollIntoView 之后守卫应仍开着（等 settle）');
    const t600 = env.calls.timers.filter((t) => t.ms === 600);
    assert.equal(t600.length, 1, `layoutScroll 应排 1 个 600ms 解锁定时器，实际 ${t600.length}`);

    env.flushTimers((t) => t.ms === 600);
    assert.equal(env.api.get('pdfSuppressSave'), false, '600ms 后守卫必须放开，否则此后所有进度都不再保存');
  });

  test('E2 layoutScroll 确实滚到了 startPage（restore 目标页）', () => {
    const env = loadSandbox();
    const total = 20;
    const pagesEl = env.makeEl('div');
    env.api.layoutScroll(makeDoc(total), total, pagesEl, mkBook(), 12);
    const divs = env.api.get('pdfPageDivs');
    assert.equal(divs[12].__scrolledIntoView, 1, 'rAF 应对 startPage 页槽调用 scrollIntoView()');
    assert.ok(!divs[1].__scrolledIntoView, '不应滚到第 1 页');
  });

  test('E3 解锁后紧接着的滚动能正常保存（守卫只影响 restore 窗口）', () => {
    const env = loadSandbox();
    const total = 100;
    const { pagesEl, divs } = mountPages(env, total, 50);
    const b = mkBook({ lastPage: 50 });
    env.api.set('pdfCurrentPage', 50);
    env.api.set('pdfSuppressSave', true);
    env.api.setupScrollSpy(makeDoc(total), total, pagesEl, b);

    // ① restore 窗口内：被吞
    setVisiblePage(divs, total, 1);
    pagesEl.onscroll();
    assert.equal(b.lastPage, 50, 'restore 窗口内不该保存');

    // ② 模拟 600ms 到期解锁
    env.api.set('pdfSuppressSave', false);

    // ③ 用户真的翻到第 60 页
    setVisiblePage(divs, total, 60);
    pagesEl.onscroll();
    assert.equal(b.lastPage, 60, '解锁后必须恢复保存能力');
    env.flushTimers();
    assert.deepEqual(env.calls.persistCog, [1], '解锁后应正常落盘');
  });
});

/* ══════════════════════ F 端到端 restore ══════════════════════ */

describe('F. 端到端：lastPage=50 的书开卷', () => {
  test('F1 滚动模式：startPage=50、守卫被置位、滚到第 50 页、lastPage 未被冲掉', async () => {
    const env = loadSandbox({ mode: 'scroll', total: 100 });
    const b = mkBook({ lastPage: 50 });
    env.api.registerEl('#pdfPages', env.makeEl('div'));

    const startPage = await env.api.runRestore(makeDoc(100), 100, b);

    assert.equal(startPage, 50, '续读页计算错误：b.lastPage=50 应还原到第 50 页');
    assert.equal(env.api.get('pdfCurrentPage'), 50, 'pdfCurrentPage 应定位到续读页');
    const divs = env.api.get('pdfPageDivs');
    assert.equal(divs[50].__scrolledIntoView, 1, '应程序化滚动到第 50 页');
    assert.equal(b.lastPage, 50, '开卷流程本身不得改写 lastPage');
    assert.deepEqual(env.calls.persistCog, [], '开卷阶段不该落盘');
  });

  test('F2 端到端：开卷后立刻触发一次「DOM 还停在第 1 页」的 onscroll，lastPage 仍是 50', async () => {
    const env = loadSandbox({ mode: 'scroll', total: 100 });
    const b = mkBook({ lastPage: 50 });
    const pagesEl = env.makeEl('div');
    pagesEl.__top = 0;
    env.api.registerEl('#pdfPages', pagesEl);

    await env.api.runRestore(makeDoc(100), 100, b);

    // layoutScroll 建出来的真实页槽（全部 top=0），把它们摆成「可视页=1」
    const divs = env.api.get('pdfPageDivs');
    for (let i = 1; i <= 100; i++) divs[i].__top = (i - 1) * 100;

    assert.equal(typeof pagesEl.onscroll, 'function', 'setupScrollSpy 未绑定 onscroll');
    pagesEl.onscroll();

    assert.equal(b.lastPage, 50, '端到端回归失败：开卷后的首个 onscroll 又把进度打回了第 1 页');
    env.flushTimers((t) => t.ms === 400);
    assert.deepEqual(env.calls.scheduleSync, [], '开卷竞态不得把第 1 页推上云');
  });

  test('F3 单页模式也会置位并留下 600ms 兜底解锁（否则守卫永久卡死）', async () => {
    const env = loadSandbox({ mode: 'page', total: 100 });
    const b = mkBook({ lastPage: 50 });
    env.api.registerEl('#pdfPages', env.makeEl('div'));

    const startPage = await env.api.runRestore(makeDoc(100), 100, b);

    assert.equal(startPage, 50, '单页模式续读页应同样为 50');
    assert.deepEqual(env.calls.renderPage, [50], '单页模式应渲染第 50 页');
    assert.equal(b.lastPage, 50, '单页模式 restore 也不该改写 lastPage');
    const t600 = env.calls.timers.filter((t) => t.ms === 600);
    assert.equal(t600.length, 1, '单页模式缺少 600ms 兜底解锁 → 守卫会永久卡死，此后再也不保存进度');
    env.flushTimers((t) => t.ms === 600);
    assert.equal(env.api.get('pdfSuppressSave'), false, '兜底解锁未生效');
  });

  test('F4 startPage 边界：lastPage 越界收敛到 total，缺省/0 回落到第 1 页', async () => {
    for (const [lastPage, want] of [[999, 100], [0, 1], [undefined, 1], [1, 1], [100, 100]]) {
      const env = loadSandbox({ mode: 'scroll', total: 100 });
      env.api.registerEl('#pdfPages', env.makeEl('div'));
      const got = await env.api.runRestore(makeDoc(100), 100, mkBook({ lastPage }));
      assert.equal(got, want, `lastPage=${lastPage} 应还原到第 ${want} 页，实际 ${got}`);
    }
  });
});

/* ══════════════════════ G 模式切换（同一竞态的第二个触发口）══════════════════════ */

/**
 * 该竞态有两个触发口：
 *   ① 开卷（renderPdfBook）—— 由 A/C/F 组覆盖
 *   ② 用户在深页点「📜 滚动」切模式（#pdfModeBtn）—— 本组覆盖
 * ② 同样会 layoutScroll → scrollIntoView，settle 前 scrollSpy 一样会把 lastPage 打回 1。
 * 修复：切到滚动模式前先 pdfSuppressSave = true（解锁复用 layoutScroll rAF 里那个 600ms）。
 */
describe('G. 模式切换 page→scroll 不得把 lastPage 打回 1', () => {
  /**
   * 装配「用户正在第 50 页单页阅读」，返回点按钮的闭包。
   * 走的是真实 bindPdfToolbar 绑定的 onclick，不是手搓分支。
   */
  function mountToolbar(env, { page = 50, total = 100 } = {}) {
    const b = mkBook({ lastPage: page });
    const pagesEl = env.makeEl('div');
    pagesEl.__top = 0;
    env.api.registerEl('#pdfPages', pagesEl);
    env.api.set('pdfCurrentPage', page);
    env.api.set('pdfTotal', total);
    env.api.set('pdfSuppressSave', false);   // 正常阅读中，守卫本来就是关的

    // 捕获「进入 layoutScroll 那一刻」守卫的值 —— 这才是本组要锁死的契约
    let guardAtCall = null;
    const real = env.api.get('layoutScroll');
    env.api.set('layoutScroll', function (...a) { guardAtCall = env.api.get('pdfSuppressSave'); return real(...a); });

    env.api.bindPdfToolbar(makeDoc(total), total, pagesEl, b);
    return { b, pagesEl, total, click: () => env.api.get('__els')['#pdfModeBtn'].onclick(), guard: () => guardAtCall };
  }

  test('G1 第 50 页点「📜 滚动」→ 进 layoutScroll 时已上锁，lastPage 保持 50 且零落盘', () => {
    const env = loadSandbox({ mode: 'page', total: 100 });
    const t = mountToolbar(env);

    t.click();                                        // 用户切到滚动模式

    assert.equal(env.api.get('pdfMode'), 'scroll', '模式未切换到 scroll');
    assert.equal(t.guard(), true, '进入 layoutScroll 时守卫必须已开启 —— 否则 settle 竞态裸奔');

    // 程序 scrollIntoView 尚未 settle：DOM 量出来的可视页还是第 1 页
    const divs = env.api.get('pdfPageDivs');
    setVisiblePage(divs, t.total, 1);
    t.pagesEl.onscroll();

    assert.equal(t.b.lastPage, 50, `切模式竞态：lastPage 被打回了 ${t.b.lastPage}`);
    env.flushTimers((x) => x.ms === 400);
    assert.deepEqual(env.calls.persistCog, [], '切模式瞬间不得落盘');
    assert.deepEqual(env.calls.scheduleSync, [], '切模式瞬间不得同步 —— 否则第 1 页会被推上云');

    // 解锁仍由 layoutScroll 的 rAF 负责：跑完 600ms 后恢复保存能力
    assert.equal(env.api.get('pdfSuppressSave'), true, '600ms 前不应解锁');
    env.flushTimers((x) => x.ms === 600);
    assert.equal(env.api.get('pdfSuppressSave'), false, '切模式后守卫必须能被 layoutScroll 的 rAF 解锁');
    setVisiblePage(divs, t.total, 60);
    t.pagesEl.onscroll();
    assert.equal(t.b.lastPage, 60, '解锁后正常阅读应恢复保存');
  });

  test('G2 【反证】抽掉 #pdfModeBtn 的置位后，同一场景 lastPage 确实被打成 1', () => {
    // 只摘掉切模式那一处 `pdfSuppressSave = true;`，renderPdfBook 的置位保持不动，
    // 精确复现修复前的行为；命中失败时 loadSandbox 会抛（防止锚点漂移导致假通过）
    const env = loadSandbox({
      mode: 'page', total: 100,
      mutate: (src) => src.replace(
        "if(pdfMode==='scroll'){ pdfSuppressSave = true; layoutScroll(",
        "if(pdfMode==='scroll'){ layoutScroll("),
    });
    const t = mountToolbar(env);

    t.click();

    assert.equal(t.guard(), false, '反证前提：抽掉置位后进入 layoutScroll 时守卫应是关的');
    const divs = env.api.get('pdfPageDivs');
    setVisiblePage(divs, t.total, 1);
    t.pagesEl.onscroll();

    assert.equal(t.b.lastPage, 1,
      '抽掉置位后 lastPage 应被打成 1；若这里没复现，说明 G1 是假通过（场景没真正命中竞态路径）');
  });

  test('G3 切回单页（scroll→page）不置守卫，renderPage 的正常保存不被吞', () => {
    const env = loadSandbox({ mode: 'scroll', total: 100 });
    const t = mountToolbar(env, { page: 50 });

    t.click();   // scroll → page

    assert.equal(env.api.get('pdfMode'), 'page', '模式未切换到 page');
    assert.equal(env.api.get('pdfSuppressSave'), false,
      '切到单页不应上锁 —— 单页分支没有程序滚动竞态，上锁只会吞掉正常保存');
    assert.deepEqual(env.calls.renderPage, [50], '切回单页应渲染当前页');
    assert.equal(t.b.lastPage, 50, '切回单页应正常保存当前页');
  });
});
