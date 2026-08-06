/**
 * 阅读器内批注侧栏（#pdfToc 的「🖍 批注」Tab） —— 新功能测试
 *
 * 策略：与 pdf-annot.test.mjs / pdf-render.test.mjs 一致 —— **不重新实现被测逻辑**，
 *       而是从 workbench.html 按标记抽取真实源码片段（AnnoStore + afterAnnoChange +
 *       三个侧栏函数 + 真实 esc + 真实 #pdfToc 模板 HTML），放进带 mini-DOM 的 vm
 *       沙箱里真跑。断言的是线上代码本身；源码一改，测试立刻失效/报错。
 *
 * 与 pdf-annot.test.mjs 的差异：本文件自带一个**支持嵌套解析的** innerHTML 解析器与
 * **支持后代组合子**（`#pdfAnnoFilter [data-f]`）的选择器引擎——批注卡片是多层嵌套结构，
 * 且 bindPdfAnnoSidebar 依赖后代选择器，扁平解析器会让事件绑定测试假通过。
 *
 * 覆盖：
 *   A 静态结构 / 接线 / 双文件一致性
 *   B 排序（页升序 → 页内偏移升序）
 *   C 类型筛选
 *   D 空态三分支
 *   E XSS 转义
 *   F Tab 徽标语义（全书总数，非筛选后）
 *   G jumpToAnnoPage（跳页 + 闪烁定位 + 静默兜底）
 *   H bindPdfAnnoSidebar（Tab 切换 / 筛选按钮 / 状态复原）
 *   I 卡片内交互（跳转 / 编辑 / 删除）
 *   J 安全空转与集成（afterAnnoChange → renderPdfAnnoList）
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

/** AnnoStore：cogAnnos / annosOf / annoCountOfBook / removeAnno / ANNO_COLORS … */
const R_STORE = sliceBetween(
  HTML, 'let cogAnnos = LS.get("wb_cog_annos", []);', 'function fillCogCats(){', 'AnnoStore');
/** afterAnnoChange + bindPdfAnnoSidebar + jumpToAnnoPage + renderPdfAnnoList */
const R_SIDEBAR = sliceBetween(
  HTML, 'function afterAnnoChange(bookId, page){', 'function removePdfSelBtn(){', 'anno-sidebar');
/** 真实 esc()：XSS 断言必须跑线上那一份，不能用测试里手写的等价实现 */
const R_ESC = (HTML.match(/^function esc\(s\)\{.*$/m) || [])[0];
assert.ok(R_ESC, '抽取失败：找不到 esc() 定义');
/** 真实 #pdfToc 模板 HTML（renderPdfBook 里那段 aside） */
const R_ASIDE =
  sliceBetween(HTML, '<aside class="pdf-toc" id="pdfToc">', '</aside>', 'pdfToc-template') + '</aside>';

// 抽取到的侧栏区必须真的含这三个函数，否则后面的“真跑”其实跑了个寂寞
for (const fn of ['function bindPdfAnnoSidebar()', 'function jumpToAnnoPage(a)', 'function renderPdfAnnoList()']) {
  assert.ok(R_SIDEBAR.includes(fn), `侧栏源码区缺少 ${fn}（抽取边界漂移？）`);
}

/* ══════════════════════════ mini-DOM ══════════════════════════ */

/** 复合选择器单元：div.cls#id[attr="v"] */
function parseCompound(s) {
  const out = { tag: null, classes: [], attrs: [], id: null };
  const re = /^([a-zA-Z][\w-]*)|^\.([\w-]+)|^#([\w-]+)|^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/;
  let rest = s;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) break;
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.id = m[3];
    else if (m[4]) out.attrs.push([m[4], m[5] ?? m[6] ?? m[7] ?? null]);
    rest = rest.slice(m[0].length);
  }
  return out;
}
/** "a b, c" → [[a,b],[c]]：支持逗号分组 + 后代组合子（bindPdfAnnoSidebar 依赖后者） */
const parseSelector = (sel) =>
  String(sel).split(',').map((p) => p.trim().split(/\s+/).filter(Boolean).map(parseCompound));

const dataKey = (k) => k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase());

function matchesOne(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const [k, v] of c.attrs) {
    const dk = k.startsWith('data-') ? dataKey(k) : null;
    const has = dk ? el.dataset[dk] !== undefined : el.getAttribute(k) != null;
    if (!has) return false;
    if (v != null) {
      const cur = dk ? String(el.dataset[dk]) : String(el.getAttribute(k));
      if (cur !== v) return false;
    }
  }
  return true;
}
/** 右起匹配：最后一个复合单元命中自身，其余向祖先链回溯 */
function matchesChain(el, chain) {
  let i = chain.length - 1;
  if (!matchesOne(el, chain[i])) return false;
  i--;
  let cur = el.parentElement;
  while (i >= 0 && cur) {
    if (matchesOne(cur, chain[i])) i--;
    cur = cur.parentElement;
  }
  return i < 0;
}
const matches = (el, sel) => parseSelector(sel).some((ch) => matchesChain(el, ch));

class TextNode {
  constructor(t) { this.nodeType = 3; this.textContent = String(t); this.parentNode = null; }
  get parentElement() { return this.parentNode; }
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

class El {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    // 真实 DOMStringMap 会把赋值强制转成字符串，这里保持一致，避免与浏览器行为漂移
    this.dataset = new Proxy({}, { set(t, k, v) { t[k] = String(v); return true; } });
    this.attrs = {};
    this.id = '';
    this._classes = new Set();
    this._html = '';
    this._text = '';
    this.__scrolled = 0;
    this.style = {};
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
      toggle: (c, force) => {
        const want = force === undefined ? !this._classes.has(c) : !!force;
        if (want) this._classes.add(c); else this._classes.delete(c);
        return want;
      },
    };
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this._classes.add(c)); }
  get textContent() {
    if (this.childNodes.length) return this.childNodes.map((n) => n.textContent).join('');
    return this._text || '';
  }
  set textContent(v) { this.childNodes.length = 0; this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.childNodes.length = 0; this._text = ''; parseHTML(this._html, this.ownerDocument, this); }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = v;
    else if (k === 'id') this.id = String(v);
    else if (k.startsWith('data-')) this.dataset[dataKey(k)] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className || null;
    if (k === 'id') return this.id || null;
    if (k.startsWith('data-')) return this.dataset[dataKey(k)] ?? null;
    return this.attrs[k] ?? null;
  }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  __walk(fn) { for (const c of this.childNodes) { if (c.nodeType === 1) { fn(c); c.__walk(fn); } } }
  querySelectorAll(sel) { const out = []; this.__walk((e) => { if (matches(e, sel)) out.push(e); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { let e = this; while (e && e.nodeType === 1) { if (matches(e, sel)) return e; e = e.parentElement; } return null; }
  contains(n) { let e = n; while (e) { if (e === this) return true; e = e.parentNode; } return false; }
  addEventListener(t, fn) { (this.__events ||= {})[t] = [...((this.__events || {})[t] || []), fn]; }
  removeEventListener() {}
  dispatch(t, ev = {}) {
    const e = { type: t, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
    ((this.__events || {})[t] || []).forEach((fn) => fn(e));
    const on = this['on' + t];
    if (typeof on === 'function') on(e);
    return e;
  }
  getBoundingClientRect() { return this.__rect || { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }; }
  scrollIntoView() { this.__scrolled++; }
  focus() {}
}

/** 支持嵌套的极简 HTML 解析器（批注卡片是三层嵌套，扁平解析会让绑定测试假通过） */
function parseHTML(html, doc, parent) {
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  const stack = [parent];
  let last = 0, m;
  const pushText = (s) => { if (s) stack[stack.length - 1].appendChild(doc.createTextNode(s)); };
  while ((m = re.exec(html))) {
    pushText(html.slice(last, m.index));
    last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const tag = m[2].toLowerCase();
    if (m[1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) { stack.length = i; break; }
      }
      continue;
    }
    const el = doc.createElement(tag);
    const ar = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = ar.exec(m[3] || ''))) el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? '');
    stack[stack.length - 1].appendChild(el);
    if (!m[4] && !VOID_TAGS.has(tag)) stack.push(el);
  }
  pushText(html.slice(last));
}

function makeDocument() {
  const doc = {
    createElement: (t) => new El(t, doc),
    createTextNode: (t) => new TextNode(t),
    addEventListener() {}, removeEventListener() {},
  };
  doc.body = new El('body', doc);
  doc.documentElement = new El('html', doc);
  doc.querySelector = (s) => doc.body.querySelector(s);
  doc.querySelectorAll = (s) => doc.body.querySelectorAll(s);
  doc.getElementById = (id) => doc.body.querySelector('#' + id);
  return doc;
}

/* ══════════════════════════ 沙箱 ══════════════════════════ */

function loadSandbox(opts = {}) {
  const document = makeDocument();
  const calls = {
    toast: [], goToPage: [], openEditor: [], render: [], applyAnnos: [], repaint: [], ls: {},
  };
  const timers = new Map();
  let timerSeq = 0;

  const window = {
    innerWidth: 1000, innerHeight: 800,
    matchMedia: (q) => ({ media: q, matches: !!opts.mobile }),
    addEventListener() {}, removeEventListener() {},
  };

  const ctx = {
    console, document, window,
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    Math, Date, JSON, Number, String, Object, Array, Set, Map, RegExp, Error, Boolean,
    parseInt, parseFloat, isNaN, Infinity, NaN,
    // ── 外部依赖 stub ──
    LS: { get: (k, d) => (k in calls.ls ? calls.ls[k] : d), set: (k, v) => { calls.ls[k] = v; } },
    deviceId: 'devA',
    uid: (() => { let n = 0; return () => 'id' + (++n); })(),
    toast: (m) => calls.toast.push(m),
    scheduleSync: () => {},
    fmtDate: () => '',
    // 侧栏之外的渲染副作用统统记账，不真跑
    applyAnnos: (b, p) => calls.applyAnnos.push([b, p]),
    repaintRenderedPages: (b) => calls.repaint.push(b),
    renderCogAnno: () => calls.render.push('anno'),
    renderCogHome: () => calls.render.push('home'),
    renderCogBooks: () => calls.render.push('books'),
    renderBookInfo: () => calls.render.push('info'),
    pdfGoToPage: (...args) => calls.goToPage.push(args),
    openAnnoEditor: (d) => calls.openEditor.push(d),
    // ── 共享状态 ──
    cogReads: [], cogBooks: [], cogScreen: 0,
    pdfMode: 'scroll', pdfCurrentPage: 1, pdfRendered: new Set(), pdfPageDivs: {},
    pdfDoc: opts.pdfDoc === undefined ? {} : opts.pdfDoc,
    pdfTotal: 20,
    pdfPagesEl: null,
    pdfBook: opts.pdfBook === undefined ? { id: 'b1', title: '测试书' } : opts.pdfBook,
    // 源码里是 `let pdfAnnoFilter = 'all';`（在抽取区之外），这里以 ctx 全局等价注入
    pdfAnnoFilter: opts.filter || 'all',
  };
  ctx.globalThis = ctx;
  ctx.$ = (s, r) => (r || document).querySelector(s);
  ctx.$$ = (s, r) => (r || document).querySelectorAll(s);

  vm.createContext(ctx);
  // cogAnnos / ANNO_* 是词法 let/const，拿不到全局属性，用访问器桥出来（不改源码文本）
  const EXPORTS = `globalThis.API = {
    get cogAnnos(){ return cogAnnos; }, set cogAnnos(v){ cogAnnos = v; },
    ANNO_COLORS, ANNO_COLOR_DEFAULT, ANNO_TYPE_ICON, ANNO_TYPES,
  };`;
  vm.runInContext([R_ESC, R_STORE, R_SIDEBAR, EXPORTS].join('\n'), ctx, { filename: 'anno-sidebar.js' });

  // 挂真实的 #pdfToc 模板（含两个 Tab / 两个 pane / 4 个筛选按钮 / #pdfAnnoList）
  const reader = document.createElement('div');
  reader.className = 'pdf-reader';
  if (opts.mountToc !== false) reader.innerHTML = R_ASIDE;
  document.body.appendChild(reader);

  // 正文页容器（jumpToAnnoPage 找 [data-anno-id] 标记用）
  const pages = document.createElement('div');
  pages.id = 'pdfPages';
  document.body.appendChild(pages);
  ctx.pdfPagesEl = opts.pdfPagesEl === undefined ? pages : opts.pdfPagesEl;

  return {
    ctx, api: ctx.API, document, window, calls, timers, pagesEl: pages,
    /** 跑完当前排队的定时器（回调里新排的留到下一次 flush，便于分步验证 280ms / 1200ms） */
    flushTimers: () => {
      const batch = [...timers.entries()];
      batch.forEach(([id]) => timers.delete(id));
      batch.forEach(([, t]) => t.fn());
    },
  };
}

/** 造一条完整的 CogAnno 记录（绕开 addAnno 的字段归一，方便精确控制 page/startOffset） */
let SEQ = 0;
const mk = (o = {}) => ({
  id: o.id || 'a' + (++SEQ),
  bookId: o.bookId || 'b1',
  page: o.page === undefined ? 1 : o.page,
  startOffset: o.startOffset === undefined ? 0 : o.startOffset,
  endOffset: o.endOffset === undefined ? 5 : o.endOffset,
  pageTextLen: 100,
  selectedText: o.selectedText === undefined ? '原文' : o.selectedText,
  type: o.type || 'highlight',
  color: o.color || 'yellow',
  text: o.text === undefined ? '笔记' : o.text,
  createdAt: 1, updatedAt: 1, deviceId: 'devA',
  deleted: !!o.deleted,
});

/** 装一批批注并渲染，返回 sandbox */
function withAnnos(list, opts = {}) {
  const S = loadSandbox(opts);
  S.api.cogAnnos = list;
  S.ctx.renderPdfAnnoList();
  return S;
}
const cardIds = (S) => S.ctx.$('#pdfAnnoList').querySelectorAll('.anno').map((e) => e.dataset.anno);

/* ══════════════════════════ A 静态结构 / 接线 ══════════════════════════ */

describe('A 侧栏结构与接线（静态）', () => {
  test('#pdfToc 模板含双 Tab（目录 / 批注）与徽标位', () => {
    assert.match(R_ASIDE, /class="pdf-toc-tabs"/, '缺少 Tab 容器');
    assert.match(R_ASIDE, /data-tab="toc"/, '缺少目录 Tab');
    assert.match(R_ASIDE, /data-tab="anno"/, '缺少批注 Tab');
    assert.match(R_ASIDE, /id="pdfAnnoCount"/, '缺少 Tab 徽标 #pdfAnnoCount');
    // 目录 Tab 默认选中，批注 pane 默认隐藏 —— 不能默认落在批注页
    assert.match(R_ASIDE, /class="pdf-toc-tab active" data-tab="toc"/, '默认选中的不是目录 Tab');
    assert.match(R_ASIDE, /data-pane="anno"[^>]*style="display:none;"/, '批注 pane 默认未隐藏');
  });

  test('#pdfToc 模板含两个 pane、4 个类型筛选按钮与 #pdfAnnoList', () => {
    assert.equal((R_ASIDE.match(/class="pdf-toc-pane"/g) || []).length, 2, 'pane 数量不是 2');
    for (const f of ['all', 'highlight', 'comment', 'idea']) {
      assert.ok(R_ASIDE.includes(`data-f="${f}"`), `缺少筛选按钮 data-f="${f}"`);
    }
    assert.match(R_ASIDE, /id="pdfAnnoList"/, '缺少 #pdfAnnoList 容器');
    assert.match(R_ASIDE, /id="pdfTocList"/, '目录列表 #pdfTocList 被误删（目录 Tab 会空）');
    // data-f="all" 必须是默认高亮项，且只有一个 active
    assert.match(R_ASIDE, /data-f="all" class="active"/, 'all 筛选按钮默认未 active');
  });

  test('#pdfToc 模板 div/aside 开闭标签平衡', () => {
    for (const tag of ['div', 'aside', 'button', 'span']) {
      const open = (R_ASIDE.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
      const close = (R_ASIDE.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      assert.equal(open, close, `#pdfToc 模板 <${tag}> 不平衡：${open} 开 / ${close} 闭`);
    }
  });

  test('renderPdfBook 渲染后调用 bindPdfAnnoSidebar()', () => {
    assert.match(HTML, /loadPdfOutline\(doc\);\s*\n\s*bindPdfAnnoSidebar\(\);/,
      'renderPdfBook 未在 loadPdfOutline 之后调用 bindPdfAnnoSidebar()（侧栏不会绑定）');
  });

  test('afterAnnoChange 体内调用 renderPdfAnnoList()（增删改后侧栏实时同步）', () => {
    const body = sliceBetween(HTML, 'function afterAnnoChange(bookId, page){', '\n}', 'afterAnnoChange');
    assert.match(body, /renderPdfAnnoList\(\);/, 'afterAnnoChange 未调用 renderPdfAnnoList（侧栏会失同步）');
  });

  test('pdfAnnoFilter 模块级状态存在且默认 all', () => {
    assert.match(HTML, /let pdfAnnoFilter\s*=\s*'all';/, "缺少 let pdfAnnoFilter = 'all'");
  });

  test('侧栏 CSS 关键规则齐全（Tab / 筛选 / 徽标隐藏 / 闪烁动画）', () => {
    for (const rule of [
      '.pdf-toc-tabs{', '.pdf-toc-tab{', '.pdf-toc-tab.active{', '.pdf-toc-body{',
      '.pdf-toc-pane{', '.pdf-anno-filter{', '.pdf-anno-list{', '.anno-flash{',
    ]) assert.ok(HTML.includes(rule), `缺少 CSS 规则 ${rule}`);
    assert.match(HTML, /@keyframes annoFlash/, '缺少 annoFlash 关键帧');
    // 0 条时靠 :empty 隐藏徽标，规则丢了会出现一个空的小圆点
    assert.match(HTML, /\.pdf-toc-tab \.anno-count:empty\{display:none;\}/, '缺少徽标 :empty 隐藏规则');
  });

  test('index.html 与 workbench.html 侧栏实现逐字一致（双文件不许漂移）', () => {
    const other = fs.readFileSync(INDEX, 'utf8');
    assert.ok(other.includes(R_ASIDE), 'index.html 缺少 #pdfToc 侧栏模板');
    assert.ok(other.includes(R_SIDEBAR), 'index.html 的侧栏函数实现与 workbench.html 不一致');
  });
});

/* ══════════════════════════ B 排序 ══════════════════════════ */

describe('B renderPdfAnnoList 排序', () => {
  test('按页升序排列（乱序入库也要归位）', () => {
    const S = withAnnos([
      mk({ id: 'p9', page: 9 }), mk({ id: 'p2', page: 2 }), mk({ id: 'p11', page: 11 }), mk({ id: 'p1', page: 1 }),
    ]);
    assert.deepEqual(cardIds(S), ['p1', 'p2', 'p9', 'p11'], '未按页升序（注意 11 不能排在 2 前面）');
  });

  test('同页内按 startOffset 升序', () => {
    const S = withAnnos([
      mk({ id: 'c', page: 3, startOffset: 300 }),
      mk({ id: 'a', page: 3, startOffset: 10 }),
      mk({ id: 'b', page: 3, startOffset: 100 }),
    ]);
    assert.deepEqual(cardIds(S), ['a', 'b', 'c'], '同页未按 startOffset 升序');
  });

  test('页升序优先于页内偏移（跨页比较不被 offset 干扰）', () => {
    const S = withAnnos([
      mk({ id: 'p2o1', page: 2, startOffset: 1 }),
      mk({ id: 'p1o999', page: 1, startOffset: 999 }),
    ]);
    assert.deepEqual(cardIds(S), ['p1o999', 'p2o1'], '页序未优先于页内偏移');
  });

  test('想法型弱绑定（startOffset=-1）排在同页最前，不被丢弃', () => {
    const S = withAnnos([
      mk({ id: 'hl', page: 4, startOffset: 20 }),
      mk({ id: 'idea', page: 4, startOffset: -1, type: 'idea', selectedText: '' }),
    ]);
    assert.deepEqual(cardIds(S), ['idea', 'hl'], 'startOffset=-1 的想法型被漏渲染或排序错误');
  });

  test('排序不污染 cogAnnos 原数组顺序（annosOf 返回副本）', () => {
    const raw = [mk({ id: 'z', page: 9 }), mk({ id: 'a', page: 1 })];
    const S = withAnnos(raw);
    assert.deepEqual(S.api.cogAnnos.map((a) => a.id), ['z', 'a'], 'renderPdfAnnoList 就地排序污染了 cogAnnos');
  });
});

/* ══════════════════════════ C 类型筛选 ══════════════════════════ */

describe('C 类型筛选 pdfAnnoFilter', () => {
  const MIX = () => [
    mk({ id: 'h1', type: 'highlight', page: 1 }),
    mk({ id: 'c1', type: 'comment', page: 2 }),
    mk({ id: 'i1', type: 'idea', page: 3 }),
    mk({ id: 'h2', type: 'highlight', page: 4 }),
  ];

  test('all 显示全部', () => {
    assert.deepEqual(cardIds(withAnnos(MIX(), { filter: 'all' })), ['h1', 'c1', 'i1', 'h2']);
  });

  for (const [f, expect] of [['highlight', ['h1', 'h2']], ['comment', ['c1']], ['idea', ['i1']]]) {
    test(`filter=${f} 只显示该类型`, () => {
      assert.deepEqual(cardIds(withAnnos(MIX(), { filter: f })), expect, `${f} 筛选结果不对`);
    });
  }

  test('筛选后仍保持排序（筛选不打乱页序）', () => {
    const S = withAnnos([
      mk({ id: 'h9', type: 'highlight', page: 9 }),
      mk({ id: 'c5', type: 'comment', page: 5 }),
      mk({ id: 'h2', type: 'highlight', page: 2 }),
    ], { filter: 'highlight' });
    assert.deepEqual(cardIds(S), ['h2', 'h9']);
  });

  test('软删批注在任何筛选下都不出现', () => {
    const S = withAnnos([mk({ id: 'ok', page: 1 }), mk({ id: 'gone', page: 2, deleted: true })]);
    assert.deepEqual(cardIds(S), ['ok'], '软删批注被渲染出来了');
  });

  test('只显示当前书的批注（别书批注不串台）', () => {
    const S = withAnnos([mk({ id: 'mine', bookId: 'b1' }), mk({ id: 'other', bookId: 'b2' })]);
    assert.deepEqual(cardIds(S), ['mine'], '渲染了其他书的批注');
  });
});

/* ══════════════════════════ D 空态 ══════════════════════════ */

describe('D 空态三分支', () => {
  test('未打开书籍（pdfBook=null）→「未打开书籍」', () => {
    const S = withAnnos([mk({ id: 'x' })], { pdfBook: null });
    const html = S.ctx.$('#pdfAnnoList').innerHTML;
    assert.match(html, /未打开书籍/);
    assert.equal(S.ctx.$('#pdfAnnoList').querySelectorAll('.anno').length, 0, '未打开书籍却渲染了卡片');
  });

  test('本书 0 条批注 → 引导文案（提示怎么写第一条）', () => {
    const S = withAnnos([]);
    const html = S.ctx.$('#pdfAnnoList').innerHTML;
    assert.match(html, /还没有批注/);
    assert.match(html, /第一条/, '0 条时应给出写第一条的引导，而不是干巴巴一句没有');
  });

  test('本书有批注但当前筛选无命中 →「该类型下还没有批注」（与全空区分开）', () => {
    const S = withAnnos([mk({ id: 'h1', type: 'highlight' })], { filter: 'idea' });
    const html = S.ctx.$('#pdfAnnoList').innerHTML;
    assert.match(html, /该类型下还没有批注/, '筛选空态与全空态文案未区分，用户会以为批注丢了');
    assert.doesNotMatch(html, /第一条/);
  });

  test('空态下不残留上一次的卡片（重渲染真的清空）', () => {
    const S = withAnnos([mk({ id: 'a1' })]);
    assert.equal(cardIds(S).length, 1);
    S.api.cogAnnos = [];
    S.ctx.renderPdfAnnoList();
    assert.equal(S.ctx.$('#pdfAnnoList').querySelectorAll('.anno').length, 0, '旧卡片未被清除');
  });
});

/* ══════════════════════════ E XSS 转义 ══════════════════════════ */

describe('E XSS：批注内容一律转义后入 innerHTML', () => {
  const EVIL = '<script>alert(1)</script>';

  test('selectedText 里的 <script> 被转义，不落原样标签', () => {
    const S = withAnnos([mk({ id: 'x', selectedText: EVIL })]);
    const html = S.ctx.$('#pdfAnnoList').innerHTML;
    assert.doesNotMatch(html, /<script/i, 'selectedText 未转义，存在 XSS 注入');
    assert.match(html, /&lt;script&gt;/, '未按 esc() 规则转义成实体');
  });

  test('text（笔记正文）里的 <script> 被转义', () => {
    const S = withAnnos([mk({ id: 'x', selectedText: '', text: EVIL })]);
    const html = S.ctx.$('#pdfAnnoList').innerHTML;
    assert.doesNotMatch(html, /<script/i, 'text 未转义，存在 XSS 注入');
    assert.match(html, /&lt;script&gt;/);
  });

  test('img onerror 型注入不产生真实 <img> 元素', () => {
    const S = withAnnos([mk({ id: 'x', text: '<img src=x onerror=alert(1)>' })]);
    const box = S.ctx.$('#pdfAnnoList');
    assert.equal(box.querySelectorAll('img').length, 0, '注入的 <img> 被真实创建');
    assert.doesNotMatch(box.innerHTML, /<img/i);
  });

  test('双引号被转义，不能击穿属性（"onclick= 型注入）', () => {
    const S = withAnnos([mk({ id: 'x', text: '" onclick="alert(1)' })]);
    const html = S.ctx.$('#pdfAnnoList').innerHTML;
    assert.match(html, /&quot;/, '双引号未转义');
    assert.doesNotMatch(html, /"\s*onclick="alert/, '属性被击穿');
  });

  test('& 转义不产生双重转义错乱（&amp; 依然可读）', () => {
    const S = withAnnos([mk({ id: 'x', text: 'A & B' })]);
    assert.match(S.ctx.$('#pdfAnnoList').innerHTML, /A &amp; B/);
  });
});

/* ══════════════════════════ F Tab 徽标 ══════════════════════════ */

describe('F Tab 徽标 #pdfAnnoCount 语义', () => {
  test('徽标 = 全书总数，而不是筛选后的条数', () => {
    const S = withAnnos([
      mk({ id: 'h1', type: 'highlight' }), mk({ id: 'h2', type: 'highlight' }), mk({ id: 'i1', type: 'idea' }),
    ], { filter: 'idea' });
    assert.equal(cardIds(S).length, 1, '筛选后列表条数不对');
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '3', '徽标显示的是筛选后条数，应为全书总数 3');
  });

  test('0 条时徽标为空串（靠 :empty 隐藏，不显示 0）', () => {
    const S = withAnnos([]);
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '', '0 条时徽标不应有内容');
  });

  test('未打开书籍时徽标为空串', () => {
    const S = withAnnos([mk({ id: 'x' })], { pdfBook: null });
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '');
  });

  test('徽标不计软删，且不计别的书', () => {
    const S = withAnnos([
      mk({ id: 'a', bookId: 'b1' }), mk({ id: 'b', bookId: 'b1', deleted: true }), mk({ id: 'c', bookId: 'b2' }),
    ]);
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '1');
  });

  test('筛选空态下徽标仍显示全书总数（用户才知道批注没丢）', () => {
    const S = withAnnos([mk({ id: 'h1', type: 'highlight' })], { filter: 'idea' });
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '1');
  });
});

/* ══════════════════════════ G jumpToAnnoPage ══════════════════════════ */

describe('G jumpToAnnoPage 跳页 + 闪烁定位', () => {
  /** 在正文容器里造一个带 data-anno-id 的标记 span */
  function putMarker(S, id) {
    const sp = S.document.createElement('span');
    sp.setAttribute('data-anno-id', id);
    S.pagesEl.appendChild(sp);
    return sp;
  }

  test('以 (pdfDoc, pdfTotal, pdfPagesEl, pdfBook, page) 调用 pdfGoToPage，且 page 是 Number', () => {
    const S = loadSandbox();
    S.ctx.jumpToAnnoPage({ id: 'a1', page: '7' });
    assert.equal(S.calls.goToPage.length, 1, '未调用 pdfGoToPage');
    const [doc, total, pagesEl, book, page] = S.calls.goToPage[0];
    assert.equal(doc, S.ctx.pdfDoc);
    assert.equal(total, 20);
    assert.equal(pagesEl, S.ctx.pdfPagesEl);
    assert.equal(book, S.ctx.pdfBook);
    assert.equal(page, 7, 'page 未转成数字（字符串会让翻页逻辑比较出错）');
    assert.equal(typeof page, 'number');
  });

  test('280ms 后给对应标记加 .anno-flash 并 scrollIntoView，1200ms 后移除', () => {
    const S = loadSandbox();
    const m = putMarker(S, 'a1');
    S.ctx.jumpToAnnoPage({ id: 'a1', page: 3 });
    assert.equal(m.classList.contains('anno-flash'), false, '不应同步加闪烁（页面还没渲染完）');
    S.flushTimers();                                    // 280ms
    assert.equal(m.classList.contains('anno-flash'), true, '跳页后未给标记加 .anno-flash');
    assert.equal(m.__scrolled, 1, '未 scrollIntoView 到标记');
    S.flushTimers();                                    // 1200ms
    assert.equal(m.classList.contains('anno-flash'), false, '.anno-flash 未在 1200ms 后移除（动画会一直挂着）');
  });

  test('只闪对应 id 的标记，不误伤其它批注', () => {
    const S = loadSandbox();
    const m1 = putMarker(S, 'a1'), m2 = putMarker(S, 'a2');
    S.ctx.jumpToAnnoPage({ id: 'a1', page: 3 });
    S.flushTimers();
    assert.equal(m1.classList.contains('anno-flash'), true);
    assert.equal(m2.classList.contains('anno-flash'), false, '闪烁误伤了其它批注标记');
  });

  test('找不到标记（想法型不落页面）时静默跳过，不抛错', () => {
    const S = loadSandbox();
    S.ctx.jumpToAnnoPage({ id: 'ghost', page: 3 });
    assert.equal(S.calls.goToPage.length, 1, '仍应先跳页');
    assert.doesNotThrow(() => S.flushTimers(), '标记不存在时抛错了');
  });

  test('page 为空 / 0 / 传 null 时直接返回，不跳页', () => {
    const S = loadSandbox();
    for (const a of [null, undefined, {}, { id: 'a', page: 0 }, { id: 'a', page: null }]) {
      S.ctx.jumpToAnnoPage(a);
    }
    assert.equal(S.calls.goToPage.length, 0, '无效 page 也触发了跳页');
  });

  test('pdfDoc / pdfPagesEl 缺失（阅读器未就绪）时不跳页也不抛', () => {
    const S1 = loadSandbox({ pdfDoc: null });
    assert.doesNotThrow(() => S1.ctx.jumpToAnnoPage({ id: 'a', page: 2 }));
    assert.equal(S1.calls.goToPage.length, 0);
    const S2 = loadSandbox({ pdfPagesEl: null });
    assert.doesNotThrow(() => S2.ctx.jumpToAnnoPage({ id: 'a', page: 2 }));
    assert.equal(S2.calls.goToPage.length, 0);
  });

  test('移动端（<=760px）跳页后自动收起浮层目录', () => {
    const S = loadSandbox({ mobile: true });
    S.ctx.$('#pdfToc').classList.add('show');
    S.ctx.jumpToAnnoPage({ id: 'a1', page: 3 });
    assert.equal(S.ctx.$('#pdfToc').classList.contains('show'), false, '移动端跳页后侧栏未收起，会挡住正文');
  });

  test('桌面端跳页不收起侧栏', () => {
    const S = loadSandbox({ mobile: false });
    S.ctx.$('#pdfToc').classList.add('show');
    S.ctx.jumpToAnnoPage({ id: 'a1', page: 3 });
    assert.equal(S.ctx.$('#pdfToc').classList.contains('show'), true, '桌面端不该收起侧栏');
  });
});

/* ══════════════════════════ H bindPdfAnnoSidebar ══════════════════════════ */

describe('H bindPdfAnnoSidebar Tab 切换与筛选按钮', () => {
  const tabs = (S) => S.ctx.$('#pdfToc').querySelectorAll('.pdf-toc-tab');
  const panes = (S) => S.ctx.$('#pdfToc').querySelectorAll('.pdf-toc-pane');
  const fbtns = (S) => S.ctx.$('#pdfToc').querySelectorAll('#pdfAnnoFilter [data-f]');

  test('绑定后能选到两个 Tab、两个 pane、4 个筛选按钮（选择器不落空）', () => {
    const S = loadSandbox();
    S.ctx.bindPdfAnnoSidebar();
    assert.equal(tabs(S).length, 2);
    assert.equal(panes(S).length, 2);
    assert.equal(fbtns(S).length, 4, '后代选择器 #pdfAnnoFilter [data-f] 未选中 4 个按钮');
  });

  test('点批注 Tab：active 迁移 + 显示批注 pane + 隐藏目录 pane', () => {
    const S = loadSandbox();
    S.ctx.bindPdfAnnoSidebar();
    const [tocTab, annoTab] = tabs(S);
    annoTab.dispatch('click');
    assert.equal(annoTab.classList.contains('active'), true, '批注 Tab 未激活');
    assert.equal(tocTab.classList.contains('active'), false, '目录 Tab 的 active 未摘掉（两个都亮）');
    const byPane = Object.fromEntries(panes(S).map((p) => [p.dataset.pane, p.style.display]));
    assert.equal(byPane.anno, '', '批注 pane 未显示');
    assert.equal(byPane.toc, 'none', '目录 pane 未隐藏');
  });

  test('切回目录 Tab 能还原（可来回切，不是单向门）', () => {
    const S = loadSandbox();
    S.ctx.bindPdfAnnoSidebar();
    const [tocTab, annoTab] = tabs(S);
    annoTab.dispatch('click');
    tocTab.dispatch('click');
    assert.equal(tocTab.classList.contains('active'), true);
    assert.equal(annoTab.classList.contains('active'), false);
    const byPane = Object.fromEntries(panes(S).map((p) => [p.dataset.pane, p.style.display]));
    assert.equal(byPane.toc, '', '目录 pane 未恢复显示');
    assert.equal(byPane.anno, 'none', '批注 pane 未隐藏');
  });

  test('切到批注 Tab 时重新渲染列表（拿到最新数据）', () => {
    const S = loadSandbox();
    S.ctx.bindPdfAnnoSidebar();
    S.api.cogAnnos = [mk({ id: 'late', page: 1 })];      // 绑定之后才有的数据
    assert.equal(cardIds(S).length, 0, '前置条件：此刻列表应还是空的');
    tabs(S)[1].dispatch('click');
    assert.deepEqual(cardIds(S), ['late'], '切到批注 Tab 未重新渲染，看到的是过期列表');
  });

  test('点筛选按钮：更新 pdfAnnoFilter + active 唯一 + 列表重渲染', () => {
    const S = loadSandbox();
    S.api.cogAnnos = [mk({ id: 'h1', type: 'highlight' }), mk({ id: 'i1', type: 'idea' })];
    S.ctx.bindPdfAnnoSidebar();
    const btns = fbtns(S);
    const ideaBtn = btns.find((b) => b.dataset.f === 'idea');
    ideaBtn.dispatch('click');
    assert.equal(S.ctx.pdfAnnoFilter, 'idea', 'pdfAnnoFilter 未更新');
    assert.deepEqual(cardIds(S), ['i1'], '点筛选后列表未按类型过滤');
    assert.equal(btns.filter((b) => b.classList.contains('active')).length, 1, 'active 不唯一（多个按钮同时亮）');
    assert.equal(ideaBtn.classList.contains('active'), true);
  });

  test('四个筛选按钮依次点击都生效', () => {
    const S = loadSandbox();
    S.api.cogAnnos = [
      mk({ id: 'h1', type: 'highlight' }), mk({ id: 'c1', type: 'comment' }), mk({ id: 'i1', type: 'idea' }),
    ];
    S.ctx.bindPdfAnnoSidebar();
    const btns = fbtns(S);
    for (const [f, expect] of [
      ['highlight', ['h1']], ['comment', ['c1']], ['idea', ['i1']], ['all', ['h1', 'c1', 'i1']],
    ]) {
      btns.find((b) => b.dataset.f === f).dispatch('click');
      assert.equal(S.ctx.pdfAnnoFilter, f);
      assert.deepEqual(cardIds(S), expect, `切到 ${f} 后列表不对`);
    }
  });

  test('重建 DOM 后复原上次筛选（active 落在 pdfAnnoFilter 上，不是硬回 all）', () => {
    const S = loadSandbox({ filter: 'comment' });
    S.ctx.bindPdfAnnoSidebar();
    const btns = fbtns(S);
    assert.equal(btns.find((b) => b.dataset.f === 'comment').classList.contains('active'), true,
      '未复原上次筛选的 active 态');
    assert.equal(btns.find((b) => b.dataset.f === 'all').classList.contains('active'), false,
      '模板里 all 的默认 active 未被摘掉（UI 与实际筛选不一致）');
    assert.equal(btns.filter((b) => b.classList.contains('active')).length, 1);
  });

  test('绑定时立即算出徽标数字（用户不点批注 Tab 也能看到有几条）', () => {
    const S = loadSandbox();
    S.api.cogAnnos = [mk({ id: 'a' }), mk({ id: 'b' })];
    S.ctx.bindPdfAnnoSidebar();
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '2', 'bindPdfAnnoSidebar 未触发首次徽标计算');
  });

  test('#pdfToc 不存在时安全返回，不抛错', () => {
    const S = loadSandbox({ mountToc: false });
    assert.doesNotThrow(() => S.ctx.bindPdfAnnoSidebar(), '侧栏 DOM 缺失时 bindPdfAnnoSidebar 抛错了');
  });
});

/* ══════════════════════════ I 卡片内交互 ══════════════════════════ */

describe('I 批注卡片交互（跳转 / 编辑 / 删除）', () => {
  test('卡片渲染出类型图标、页码 chip、原文引用与笔记', () => {
    const S = withAnnos([mk({ id: 'a1', page: 5, type: 'comment', selectedText: '被选中的原文', text: '我的想法' })]);
    const card = S.ctx.$('#pdfAnnoList').querySelector('.anno');
    const html = S.ctx.$('#pdfAnnoList').innerHTML;
    assert.ok(card, '未渲染出卡片');
    assert.equal(card.querySelector('.a-page').dataset.page, '5', '页码 chip 缺失或页码错');
    assert.match(html, /💬/, '缺少类型图标');
    assert.match(html, /评论/, '缺少类型文案');
    assert.match(html, /被选中的原文/);
    assert.match(html, /我的想法/);
  });

  test('三种类型各自的图标与文案正确', () => {
    for (const [type, icon, label] of [['highlight', '🖍', '高亮'], ['comment', '💬', '评论'], ['idea', '💡', '想法']]) {
      const S = withAnnos([mk({ id: 't', type })]);
      const html = S.ctx.$('#pdfAnnoList').innerHTML;
      assert.ok(html.includes(icon), `${type} 图标应为 ${icon}`);
      assert.ok(html.includes(label), `${type} 文案应为 ${label}`);
    }
  });

  test('page 为空的批注不渲染页码 chip（点了也没处可跳）', () => {
    const S = withAnnos([mk({ id: 'a1', page: 0, startOffset: -1, type: 'idea' })]);
    assert.equal(S.ctx.$('#pdfAnnoList').querySelector('.a-page'), null, '无页码却渲染了跳转 chip');
  });

  test('点页码 chip → jumpToAnnoPage（真的跳到那一页）', () => {
    const S = withAnnos([mk({ id: 'a1', page: 6 })]);
    S.ctx.$('#pdfAnnoList').querySelector('.a-page').dispatch('click');
    assert.equal(S.calls.goToPage.length, 1, '点页码未跳页');
    assert.equal(S.calls.goToPage[0][4], 6, '跳错页');
  });

  test('点 ✏️ → openAnnoEditor({annoId})', () => {
    const S = withAnnos([mk({ id: 'a1' }), mk({ id: 'a2', page: 2 })]);
    S.ctx.$('#pdfAnnoList').querySelectorAll('[data-act="edit"]')[1].dispatch('click');
    // 注意：draft 对象是沙箱 realm 造的，原型与宿主不同，deepStrictEqual 会假失败 —— 逐字段比
    assert.equal(S.calls.openEditor.length, 1, '编辑按钮未唤起编辑器');
    assert.equal(S.calls.openEditor[0].annoId, 'a2', '编辑按钮未带对正确的 annoId');
    assert.deepEqual(Object.keys(S.calls.openEditor[0]), ['annoId'], 'draft 应只带 annoId（走「编辑已有」分支）');
  });

  test('点 🗑 → 软删该条 + 列表少一条 + toast 提示', () => {
    const S = withAnnos([mk({ id: 'a1', page: 1 }), mk({ id: 'a2', page: 2 })]);
    S.ctx.$('#pdfAnnoList').querySelectorAll('[data-act="del"]')[0].dispatch('click');
    assert.equal(S.api.cogAnnos.find((a) => a.id === 'a1').deleted, true, 'a1 未被软删');
    assert.deepEqual(cardIds(S), ['a2'], '删除后列表未同步刷新');
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '1', '删除后徽标未同步');
    assert.deepEqual(S.calls.toast, ['已删除']);
  });

  test('删除是软删（记录仍在 cogAnnos，保证多端同步可传播）', () => {
    const S = withAnnos([mk({ id: 'a1' })]);
    S.ctx.$('#pdfAnnoList').querySelector('[data-act="del"]').dispatch('click');
    assert.equal(S.api.cogAnnos.length, 1, '被硬删了，多端同步会复活这条批注');
  });

  test('删除会连带重绘正文（afterAnnoChange 收尾链路没断）', () => {
    const S = withAnnos([mk({ id: 'a1', page: 3 })]);
    S.ctx.$('#pdfAnnoList').querySelector('[data-act="del"]').dispatch('click');
    assert.deepEqual(S.calls.applyAnnos, [['b1', 3]], '未重绘对应页的正文标记');
    assert.ok(S.calls.render.includes('anno'), '未联动刷新屏 6 批注列表');
  });

  test('每张卡片都带 data-anno（事件能找回对应记录）', () => {
    const S = withAnnos([mk({ id: 'a1', page: 1 }), mk({ id: 'a2', page: 2 })]);
    assert.deepEqual(cardIds(S), ['a1', 'a2']);
  });
});

/* ══════════════════════════ J 安全空转与集成 ══════════════════════════ */

describe('J 安全空转与 afterAnnoChange 集成', () => {
  test('阅读器未挂载（无 #pdfAnnoList）时 renderPdfAnnoList 安全空转', () => {
    const S = loadSandbox({ mountToc: false });
    S.api.cogAnnos = [mk({ id: 'a1' })];
    assert.doesNotThrow(() => S.ctx.renderPdfAnnoList(), '阅读器未打开时渲染抛错（屏 6 删批注会崩）');
  });

  test('容器已从文档卸载（detached）时也空转 —— document.body.contains 兜底', () => {
    const S = loadSandbox();
    const orphan = S.document.createElement('div');
    orphan.setAttribute('id', 'pdfAnnoList');
    orphan.innerHTML = '<div class="anno" data-anno="stale"></div>';
    S.ctx.$ = () => orphan;                 // 模拟拿到一个已卸载的旧容器
    S.api.cogAnnos = [mk({ id: 'a1' })];
    assert.doesNotThrow(() => S.ctx.renderPdfAnnoList());
    assert.match(orphan.innerHTML, /stale/, 'detached 容器被写入了内容（应当直接返回）');
  });

  test('afterAnnoChange 会调用 renderPdfAnnoList（侧栏中央同步钩子）', () => {
    const S = loadSandbox();
    let hit = 0;
    const real = S.ctx.renderPdfAnnoList;
    S.ctx.renderPdfAnnoList = (...a) => { hit++; return real(...a); };
    S.ctx.afterAnnoChange('b1', 3);
    assert.equal(hit, 1, 'afterAnnoChange 未调用 renderPdfAnnoList，侧栏会失同步');
  });

  test('新增批注后 afterAnnoChange 让侧栏列表与徽标一起更新', () => {
    const S = withAnnos([]);
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '');
    S.api.cogAnnos = [...S.api.cogAnnos, mk({ id: 'new1', page: 2 })];
    S.ctx.afterAnnoChange('b1', 2);
    assert.deepEqual(cardIds(S), ['new1'], '新增后侧栏列表未刷新');
    assert.equal(S.ctx.$('#pdfAnnoCount').textContent, '1', '新增后徽标未刷新');
  });

  test('afterAnnoChange 不传 page 时走整书重绘，侧栏照样刷新', () => {
    const S = withAnnos([mk({ id: 'a1' })]);
    S.ctx.afterAnnoChange('b1', null);
    assert.deepEqual(S.calls.repaint, ['b1'], '未走 repaintRenderedPages');
    assert.deepEqual(cardIds(S), ['a1']);
  });

  test('屏 6 联动渲染仍被调用（侧栏没有抢掉原有链路）', () => {
    const S = withAnnos([]);
    S.calls.render.length = 0;
    S.ctx.afterAnnoChange('b1', 1);
    for (const r of ['anno', 'home', 'books']) {
      assert.ok(S.calls.render.includes(r), `afterAnnoChange 丢了 render:${r}`);
    }
  });

  test('反复渲染幂等：连续调用不会翻倍卡片', () => {
    const S = withAnnos([mk({ id: 'a1' }), mk({ id: 'a2', page: 2 })]);
    S.ctx.renderPdfAnnoList();
    S.ctx.renderPdfAnnoList();
    assert.deepEqual(cardIds(S), ['a1', 'a2'], '重复渲染产生了重复卡片');
  });
});

/* ══════════════════════════ K 与正文标记的隔离 ══════════════════════════ */

/**
 * 侧栏卡片复用了 `.anno` 类名，而正文文字层的高亮 span 也叫 `.anno`。
 * 两者靠「div vs span 标签限定」+「data-anno vs data-anno-id 属性区分」互不干扰。
 * 这层约定很脆（未来谁把 span.anno 放宽成 .anno 就会互相误伤），这里逐条焊死。
 */
describe('K 侧栏卡片与正文高亮标记互不误伤', () => {
  test('侧栏卡片用 data-anno，正文标记用 data-anno-id（属性命名空间不重叠）', () => {
    const S = withAnnos([mk({ id: 'a1', page: 1 })]);
    const card = S.ctx.$('#pdfAnnoList').querySelector('.anno');
    assert.equal(card.dataset.anno, 'a1', '卡片应携带 data-anno');
    assert.equal(card.dataset.annoId, undefined,
      '卡片不能带 data-anno-id，否则 jumpToAnnoPage / 正文点击委托会把侧栏卡片当成正文标记');
  });

  test('clearAnnoMarks 用 span.anno 且限定在文字层内（清不到侧栏 div.anno 卡片）', () => {
    const body = sliceBetween(HTML, 'function clearAnnoMarks(layerEl){', '\n}', 'clearAnnoMarks');
    assert.match(body, /layerEl\.querySelectorAll\('span\.anno'\)/,
      'clearAnnoMarks 必须 span 限定 + layerEl 作用域，否则重绘会清空侧栏卡片');
  });

  test('正文点击委托用 span.anno[data-anno-id]（不会命中侧栏卡片）', () => {
    assert.match(HTML, /closest\('span\.anno\[data-anno-id\], \.anno-dot\[data-anno-id\]'\)/,
      '正文批注气泡的事件委托必须 span 限定，否则点侧栏卡片会弹出正文气泡');
  });

  test('jumpToAnnoPage 的标记查找限定在 pdfPagesEl 内，不是全局 document', () => {
    assert.match(R_SIDEBAR, /pdfPagesEl\.querySelector\('\[data-anno-id="' \+ a\.id \+ '"\]'\)/,
      '标记查找必须限定在正文容器内，全局查找会误命中其它面板');
  });

  test('侧栏渲染不会给正文容器留下任何残留节点', () => {
    const S = withAnnos([mk({ id: 'a1', page: 1 }), mk({ id: 'a2', page: 2 })]);
    assert.equal(S.pagesEl.childNodes.length, 0, '渲染侧栏时污染了正文容器');
  });

  test('侧栏卡片样式有窄栏覆盖（.pdf-anno-list .anno），不直接吃通用卡片尺寸', () => {
    assert.match(HTML, /\.pdf-anno-list \.anno\{[^}]*padding:/,
      '缺少 .pdf-anno-list .anno 紧凑化覆盖，侧栏里卡片会撑爆');
  });

  test('正文高亮 span 不吃通用 .anno 卡片盒模型', () => {
    const m = HTML.match(/\.pdf-page \.textLayer span\.anno\{([^}]*)\}/);
    assert.ok(m, '找不到 .pdf-page .textLayer span.anno 规则');
    const rule = m[1];
    for (const p of ['padding:0', 'border:0', 'box-shadow:none'])
      assert.ok(rule.includes(p), `span.anno 缺少重置 ${p}，会吃到 .anno 卡片样式`);
  });
});
