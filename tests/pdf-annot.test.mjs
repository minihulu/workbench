/**
 * PDF 批注系统（T01-T03）+ 小说风书架（T04） —— 回归 / 新功能测试
 *
 * 策略：与 pdf-render.test.mjs 一致 —— **不重新实现被测逻辑**，而是从 workbench.html
 *       按标记抽取真实源码片段，放进带 mini-DOM 的 vm 沙箱里真跑。
 *       断言的是线上代码本身；源码一改，测试立刻失效/报错。
 *
 * 覆盖：
 *   A 语法 / 双文件一致性 / 静态不变量
 *   C 旧高亮实现零残留
 *   D 三个高亮 bug 根治（真跑 rangeToOffsets + applyAnnos）★最高风险
 *   E AnnoStore 数据链路（增改软删 / 迁移幂等 / 同步）
 *   F 批注交互（工具栏 / 事件委托 / 弹窗）
 *   G 书架重构（竖版封面 / 长按菜单 / 级联软删 / 屏位解耦）
 *   H 既有功能未被破坏
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
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

const R_STORE = sliceBetween(
  HTML, 'let cogAnnos = LS.get("wb_cog_annos", []);', 'function fillCogCats(){', 'AnnoStore');
const R_SCREEN = sliceBetween(
  HTML, 'const COG_SCREEN_COUNT = 9;', 'function cogCount(k){', 'screens');
const R_SHELF = sliceBetween(
  HTML, 'function bookRecordCount(b){', '/* ---- 换封面弹窗 ---- */', 'shelf');
const R_TEXTLAYER = sliceBetween(
  HTML, 'function buildTextLayer(textContent, viewport, page){', 'function getPageLayer(page){', 'textLayer');
const R_ANCHOR = sliceBetween(
  HTML, 'function getPageLayer(page){', 'function removePdfSelBtn(){', 'anchor+renderer');
const R_UI = sliceBetween(
  HTML, 'function removePdfSelBtn(){', 'function bookTitleOf(bookId){', 'T03-ui');

/** 暴露沙箱内 let/const 词法绑定给测试（不改源码文本，避免 let→var 改写引入语义漂移） */
const EXPORTS = `
globalThis.API = {
  get cogAnnos(){ return cogAnnos; },  set cogAnnos(v){ cogAnnos = v; },
  get cogReads(){ return cogReads; },  set cogReads(v){ cogReads = v; },
  get cogBooks(){ return cogBooks; },  set cogBooks(v){ cogBooks = v; },
  get lastAnnoColor(){ return lastAnnoColor; },
  get annoEditorDraft(){ return annoEditorDraft; },
  get suppressBookClick(){ return _suppressBookClick; },
  ANNO_TYPES, ANNO_COLORS, ANNO_COLOR_DEFAULT, ANNO_TYPE_ICON, COG_SCREEN_COUNT,
  annosOf, addAnno, updateAnno, removeAnno, getAnno, annoCountOfBook, annoCountOf,
  migrateHighlightsToAnnos, persistAnnos,
  setCogScreen,
  bookProgressOf, bookCoverHtml, bookRecordCount, renderCogShelf, bindLongPress, openBookMenu, clampFixed,
  buildTextLayer,
  getPageLayer, buildPageIndex, rangeToOffsets, allIndexOf, resolveAnnoRange,
  clearAnnoMarks, ensureMarkerLayer, applyAnnos, repaintRenderedPages, afterAnnoChange,
  placeFloatAbove, draftFromSelection, showSelToolbar, bindPdfSelection,
  openAnnoEditor, saveAnnoEditor, deleteAnnoEditor, closeAnnoEditor,
  openAnnoPopover, closeAnnoPopover, removePdfSelBtn,
};
`;

/* ══════════════════════════ mini-DOM ══════════════════════════ */

/**
 * 沙箱里造出来的数组来自另一个 realm，assert/strict 的 deepEqual 会因原型不同判不等。
 * 统一过一道 Array.from 再比，避免「结构相同但 not reference-equal」的假失败。
 */
const eqArr = (actual, expected, msg) => assert.deepEqual(Array.from(actual), expected, msg);

/** 极简选择器：支持 "tag.cls[attr=\\"v\\"]" 复合 + 逗号分组 */
function parseSelector(sel) {
  return String(sel).split(',').map((part) => {
    const s = part.trim();
    const out = { tag: null, classes: [], attrs: [], id: null };
    const re = /^([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/;
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
  });
}

function matchesOne(el, c) {
  if (el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
  for (const [k, v] of c.attrs) {
    const dk = k.startsWith('data-')
      ? k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())
      : null;
    const has = dk ? el.dataset[dk] !== undefined : el.getAttribute(k) != null;
    if (!has) return false;
    if (v != null) {
      const cur = dk ? String(el.dataset[dk]) : String(el.getAttribute(k));
      if (cur !== v) return false;
    }
  }
  return true;
}
const matches = (el, sel) => parseSelector(sel).some((c) => matchesOne(el, c));

class TextNode {
  constructor(t) { this.nodeType = 3; this.textContent = String(t); this.parentNode = null; }
  get parentElement() { return this.parentNode; }
}

let RECT_SEQ = 0;
class El {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    // 真实 DOMStringMap 会把赋值强制转成字符串（container.dataset.page = 11 → "11"），
    // 若这里存成 number，[data-page="11"] 选择器与 dataset 断言就会与浏览器行为漂移。
    this.dataset = new Proxy({}, {
      set(t, k, v) { t[k] = String(v); return true; },
    });
    this.attrs = {};
    this.id = '';
    this._classes = new Set();
    this._html = '';
    this.__events = {};
    this.__rect = null;
    this.style = {
      _p: {},
      setProperty(k, v) { this._p[k] = String(v); },
      getPropertyValue(k) { return this._p[k] ?? ''; },
    };
    this.classList = {
      add: (...c) => c.forEach((x) => this._classes.add(x)),
      remove: (...c) => c.forEach((x) => this._classes.delete(x)),
      contains: (c) => this._classes.has(c),
      toggle: (c) => (this._classes.has(c) ? (this._classes.delete(c), false) : (this._classes.add(c), true)),
    };
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get className() { return [...this._classes].join(' '); }
  set className(v) { this._classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => this._classes.add(c)); }
  get textContent() {
    if (this.childNodes.length) return this.childNodes.map((n) => n.textContent).join('');
    return this._text || '';
  }
  set textContent(v) { this.childNodes.length = 0; this._text = String(v); }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.childNodes.length = 0; this.__parseHtml(); }
  /** 只解析测试真正依赖的一层：<button ...>text</button> / <div ...> / <span ...> */
  __parseHtml() {
    const re = /<(button|div|span|i|img)\b([^>]*)>/g;
    let m;
    while ((m = re.exec(this._html))) {
      const el = this.ownerDocument.createElement(m[1]);
      const attrs = m[2] || '';
      const ar = /([\w-]+)\s*=\s*"([^"]*)"/g;
      let a;
      while ((a = ar.exec(attrs))) el.setAttribute(a[1], a[2]);
      this.appendChild(el);
    }
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = v;
    else if (k === 'id') this.id = String(v);
    else if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className || null;
    if (k === 'id') return this.id || null;
    if (k.startsWith('data-')) {
      const dk = k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase());
      return this.dataset[dk] ?? null;
    }
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
  addEventListener(t, fn) { (this.__events[t] ||= []).push(fn); }
  removeEventListener(t, fn) { const l = this.__events[t]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  dispatch(t, ev = {}) {
    const e = { type: t, target: this, preventDefault() {}, stopPropagation() {}, ...ev };
    (this.__events[t] || []).forEach((fn) => fn(e));
    const on = this['on' + t];
    if (typeof on === 'function') on(e);
    return e;
  }
  getBoundingClientRect() {
    if (this.__rect) return this.__rect;
    const i = ++RECT_SEQ;
    return { left: i, top: i, right: i + 10, bottom: i + 10, width: 10, height: 10, x: i, y: i };
  }
  scrollIntoView() { this.__scrolled = (this.__scrolled || 0) + 1; }
  get offsetWidth() { return this.__ow ?? 10; }
  get offsetHeight() { return this.__oh ?? 10; }
  focus() { this.__focused = true; }
  select() {}
}

function makeDocument() {
  const doc = {
    createElement: (t) => new El(t, doc),
    createTextNode: (t) => new TextNode(t),
    __listeners: {},
    addEventListener(t, fn, cap) { (doc.__listeners[t] ||= []).push({ fn, cap }); },
    removeEventListener() {},
    documentElement: null,
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
  const calls = { toast: [], scheduleSync: 0, render: [], ls: {} };
  let selection = null;

  const window = {
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    getSelection: () => selection,
    addEventListener() {}, removeEventListener() {},
    scrollTo() {},
  };

  // 可取消的假定时器：bindLongPress 的「滑动即取消」全靠 clearTimeout 真生效，
  // 用 no-op 版本会让「滑动不该弹菜单」变成假通过。
  const timers = new Map();
  let timerSeq = 0;

  const ctx = {
    console,
    document, window, navigator: { clipboard: null },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    Math, Date, JSON, Number, String, Object, Array, Set, Map, RegExp, Error, Boolean, Infinity, NaN,
    parseInt, parseFloat, isNaN,
    // ── 外部依赖 stub ──
    LS: { get: (k, d) => (k in calls.ls ? calls.ls[k] : d), set: (k, v) => { calls.ls[k] = v; } },
    // 轻量设置对象（与源码 settings/Settings 同契约）：autoTranslate 默认 false。
    // 源码里 Settings 在 workbench.html 顶层定义（line ~1793），落在沙箱抽取区域之外，
    // 这里补一份 stub，供 bindPdfSelection 读取设置（默认关闭自动翻译，不影响工具栏弹出）。
    settings: { autoTranslate: false },
    Settings: { get: (k) => (ctx.settings || {})[k], set: (k, v) => { (ctx.settings ||= { autoTranslate: false })[k] = v; } },
    deviceId: 'devA',
    uid: (() => { let n = 0; return () => 'id' + (++n); })(),
    esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    toast: (m) => calls.toast.push(m),
    scheduleSync: () => { calls.scheduleSync++; },
    fmtDate: () => '', uidShort: () => '',
    // 渲染副作用统统记账，不真跑
    renderCogAnno: () => calls.render.push('anno'),
    renderCogHome: () => calls.render.push('home'),
    renderCogBooks: () => calls.render.push('books'),
    renderBookInfo: () => calls.render.push('info'),
    openBookReader: (id) => calls.render.push('reader:' + id),
    openBookInfo: (id) => calls.render.push('binfo:' + id),
    openCoverPick: (id) => calls.render.push('cover:' + id),
    delCogBook: () => calls.render.push('delbook'),
    deleteBookFile: () => Promise.resolve(),
    // 其余共享状态
    cogReads: [], cogBooks: [], cogThoughts: [], cogReviews: [], cogExpr: [],
    cogScreen: 0, cogBookId: null, cogReadingBookId: 'b1', bookInfoId: null, annoFilterBookId: null,
    pdfMode: opts.pdfMode || 'scroll',
    pdfPageDivs: {}, pdfRendered: new Set(), pdfPagesEl: null, pdfCurrentPage: 1,
    _pdfSelBound: false,
  };
  ctx.globalThis = ctx;
  ctx.$ = (s, r) => (r || document).querySelector(s);
  ctx.$$ = (s, r) => (r || document).querySelectorAll(s);

  vm.createContext(ctx);
  const src = [R_STORE, R_SCREEN, R_SHELF, R_TEXTLAYER, R_ANCHOR, R_UI, EXPORTS].join('\n');
  vm.runInContext(src, ctx, { filename: 'workbench-annot.js' });

  return {
    ctx, api: ctx.API, document, window, calls, timers,
    setSelection: (s) => { selection = s; },
    /** 跑完当前排队的定时器（回调里新排的留到下一次 flush，便于分步验证） */
    flushTimers: () => {
      const batch = [...timers.entries()];
      batch.forEach(([id]) => timers.delete(id));
      batch.forEach(([, t]) => t.fn());
    },
  };
}

/* ── textLayer 构造工具：spans 的 textContent 拼接 = 锚定坐标系 ── */
function makeLayer(doc, texts, page, scale = 1) {
  const pageDiv = doc.createElement('div');
  pageDiv.className = 'pdf-page';
  const layer = doc.createElement('div');
  layer.className = 'textLayer';
  if (page != null) layer.setAttribute('data-page', String(page));
  layer.__rect = { left: 0, top: 0, right: 600 * scale, bottom: 800 * scale, width: 600 * scale, height: 800 * scale };
  texts.forEach((t, i) => {
    const sp = doc.createElement('span');
    sp.appendChild(doc.createTextNode(t));
    // scale 只影响像素位置，绝不影响 textContent（offset 与 scale 无关的物理基础）
    sp.__rect = { left: i * 20 * scale, top: 10 * scale, right: (i * 20 + 18) * scale, bottom: 30 * scale, width: 18 * scale, height: 20 * scale };
    layer.appendChild(sp);
  });
  pageDiv.appendChild(layer);
  return { pageDiv, layer, spans: layer.children };
}
/** 由 span 下标 + 字符内偏移造 Range（模拟真实 Selection.getRangeAt(0)） */
function makeRange(layer, si, so, ei, eo) {
  const sp = layer.children;
  return {
    startContainer: sp[si].childNodes[0], startOffset: so,
    endContainer: sp[ei].childNodes[0], endOffset: eo,
    getBoundingClientRect: () => ({ left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20 }),
  };
}
const annoSpanIdx = (layer) => layer.children.map((s, i) => [s, i]).filter(([s]) => s.classList.contains('anno')).map(([, i]) => i);

/* ══════════════════════════ A 语法 / 一致性 ══════════════════════════ */

describe('A 语法 / 双文件一致性 / 静态不变量', () => {
  test('A1 workbench.html 与 index.html 逐字节一致', () => {
    if (process.env.QA_TARGET_HTML) return; // 变异体不比对
    const a = crypto.createHash('md5').update(fs.readFileSync(WORKBENCH)).digest('hex');
    const b = crypto.createHash('md5').update(fs.readFileSync(INDEX)).digest('hex');
    assert.equal(a, b, 'index.html 未与 workbench.html 同步（会导致线上与本地行为不一致）');
  });

  test('A2 主 <script> 是合法 JS', () => {
    const open = HTML.indexOf('<script>');
    const close = HTML.indexOf('</script>', open);
    const js = HTML.slice(open + 8, close);
    assert.doesNotThrow(() => new Function(js), '主 <script> 存在语法错误');
  });

  test('A3 抽取的 6 个源码区块都能独立解析', () => {
    for (const [n, r] of Object.entries({ R_STORE, R_SCREEN, R_SHELF, R_TEXTLAYER, R_ANCHOR, R_UI })) {
      assert.doesNotThrow(() => new Function(r), `${n} 区块语法错误`);
      assert.ok(r.length > 200, `${n} 抽取内容过短（${r.length}），锚点可能漂移`);
    }
  });

  test('A4 沙箱能成功装载全部区块并导出 API', () => {
    const { api } = loadSandbox();
    for (const k of ['addAnno', 'annosOf', 'applyAnnos', 'rangeToOffsets', 'getPageLayer', 'renderCogShelf']) {
      assert.equal(typeof api[k], 'function', `API.${k} 未导出`);
    }
  });
});

/* ══════════════════════════ C 旧高亮零残留 ══════════════════════════ */

describe('C 旧高亮实现零残留', () => {
  const DEAD = [
    ['applyHighlights', /applyHighlights/],
    ['addHighlight', /addHighlight/],
    ['span.hl 选择器', /span\.hl\b/],
    ["classList.add('hl')", /classList\.add\(\s*['"]hl['"]\s*\)/],
    ['.hl CSS 类定义', /\.hl\s*\{/],
  ];
  for (const [name, re] of DEAD) {
    test(`C-${name} 已彻底移除`, () => {
      assert.equal(re.test(HTML), false, `仍存在旧高亮残留：${name}`);
    });
  }
  test('C-applyAnnos 是唯一上色入口且无 scope 参数', () => {
    assert.match(HTML, /function applyAnnos\(bookId,\s*page\)\{/, 'applyAnnos 签名变了（不应有 scope 参数）');
  });
});

/* ══════════════════════════ D 三个高亮 bug 根治 ══════════════════════════ */

describe('D 高亮三大 bug 根治（真跑锚定引擎）', () => {
  /* ── D1 同页重复短语：只高亮选中的那一处 ── */
  test('D1 同页重复短语 —— rangeToOffsets 给出选中处的精确 offset', () => {
    const S = loadSandbox();
    // full = "abc高亮def高亮ghi"，两个「高亮」分别在 [3,5) 和 [8,10)
    const { layer } = makeLayer(S.document, ['abc', '高亮', 'def', '高亮', 'ghi'], 7);
    const idx = S.api.buildPageIndex(layer);
    assert.equal(idx.full, 'abc高亮def高亮ghi');
    eqArr(idx.starts, [0, 3, 5, 8, 10]);

    const off = S.api.rangeToOffsets(makeRange(layer, 3, 0, 3, 2)); // 选中第二个「高亮」
    assert.ok(off, 'rangeToOffsets 返回 null（跨行/重复短语场景直接丢批注）');
    assert.equal(off.startOffset, 8, '选中第 2 个「高亮」却算成了第 1 个 —— 重复短语错位 bug 未根治');
    assert.equal(off.endOffset, 10);
    assert.equal(off.selectedText, '高亮');
    assert.equal(off.pageTextLen, idx.full.length);
    assert.equal(off.page, 7);
  });

  test('D1b 同页重复短语 —— applyAnnos 只给选中处上色，另一处不被误标', () => {
    const S = loadSandbox();
    const { pageDiv, layer } = makeLayer(S.document, ['abc', '高亮', 'def', '高亮', 'ghi'], 7);
    S.ctx.pdfPageDivs[7] = pageDiv;
    S.document.body.appendChild(pageDiv);

    const off = S.api.rangeToOffsets(makeRange(layer, 3, 0, 3, 2));
    S.api.addAnno({ bookId: 'b1', page: 7, ...pick(off) });
    S.api.applyAnnos('b1', 7);

    assert.deepEqual(annoSpanIdx(layer), [3],
      `只应给下标 3（第二个「高亮」）上色，实际 ${JSON.stringify(annoSpanIdx(layer))} —— 同页重复短语误标`);
    assert.equal(layer.children[1].classList.contains('anno'), false, '第一个「高亮」被误标');
  });

  test('D1c 选中第一处时同样精确（对称验证，防「永远取最后一个」的假通过）', () => {
    const S = loadSandbox();
    const { pageDiv, layer } = makeLayer(S.document, ['abc', '高亮', 'def', '高亮', 'ghi'], 7);
    S.ctx.pdfPageDivs[7] = pageDiv;
    const off = S.api.rangeToOffsets(makeRange(layer, 1, 0, 1, 2));
    assert.equal(off.startOffset, 3);
    S.api.addAnno({ bookId: 'b1', page: 7, ...pick(off) });
    S.api.applyAnnos('b1', 7);
    assert.deepEqual(annoSpanIdx(layer), [1]);
  });

  /* ── D2 跨行选中：不依赖 sel.toString() ── */
  test('D2 跨行选中 —— selectedText 取 full.slice，不含换行，能命中', () => {
    const S = loadSandbox();
    // 真实浏览器里跨行选中，sel.toString() 会在行间插入 \n；而 textLayer 拼接串没有
    const { pageDiv, layer } = makeLayer(S.document, ['第一行末尾', '第二行开头', '其余'], 3);
    S.ctx.pdfPageDivs[3] = pageDiv;
    const idx = S.api.buildPageIndex(layer);
    const domToString = '第一行末尾\n第二行开头';   // 老实现会拿这个去 indexOf

    // 先证明：老路子（sel.toString() + indexOf）必然找不到 → 这正是丢高亮的根因
    assert.equal(idx.full.indexOf(domToString), -1);
    eqArr(S.api.allIndexOf(idx.full, domToString), [],
      '前提失效：拼接串里居然含换行，说明坐标系被改坏了');

    // 新实现基于 Range 的 startContainer/startOffset，与 toString 无关
    S.setSelection({ isCollapsed: false, rangeCount: 1, getRangeAt: () => makeRange(layer, 0, 0, 1, 5), toString: () => domToString });
    const off = S.api.rangeToOffsets(makeRange(layer, 0, 0, 1, 5));
    assert.ok(off, '跨行 Range 解析失败');
    assert.equal(off.selectedText, '第一行末尾第二行开头', 'selectedText 不是 full.slice（疑似退回 sel.toString()）');
    assert.equal(off.selectedText.includes('\n'), false, 'selectedText 混入换行 —— 跨行 bug 未根治');
    assert.equal(off.startOffset, 0);
    assert.equal(off.endOffset, 10);
  });

  test('D2b 跨行选中 —— applyAnnos 把跨越的两个 span 都上色', () => {
    const S = loadSandbox();
    const { pageDiv, layer } = makeLayer(S.document, ['第一行末尾', '第二行开头', '其余'], 3);
    S.ctx.pdfPageDivs[3] = pageDiv;
    const off = S.api.rangeToOffsets(makeRange(layer, 0, 0, 1, 5));
    S.api.addAnno({ bookId: 'b1', page: 3, ...pick(off) });
    S.api.applyAnnos('b1', 3);
    assert.deepEqual(annoSpanIdx(layer), [0, 1], '跨行选中未覆盖两行 —— 跨行高亮丢失');
    assert.equal(layer.children[2].classList.contains('anno'), false, '溢出到了不该覆盖的第三段');
  });

  test('D2c 部分跨行（起止都在 span 中间）边界精确', () => {
    const S = loadSandbox();
    const { pageDiv, layer } = makeLayer(S.document, ['ABCDE', 'FGHIJ', 'KLMNO'], 3);
    S.ctx.pdfPageDivs[3] = pageDiv;
    const off = S.api.rangeToOffsets(makeRange(layer, 0, 3, 2, 2)); // "DEFGHIJKL"
    assert.equal(off.startOffset, 3);
    assert.equal(off.endOffset, 12);
    assert.equal(off.selectedText, 'DEFGHIJKL');
    S.api.addAnno({ bookId: 'b1', page: 3, ...pick(off) });
    S.api.applyAnnos('b1', 3);
    assert.deepEqual(annoSpanIdx(layer), [0, 1, 2]);
  });

  test('D2d Range 反向（endOffset < startOffset）自动纠正', () => {
    const S = loadSandbox();
    const { layer } = makeLayer(S.document, ['ABCDE', 'FGHIJ'], 3);
    const off = S.api.rangeToOffsets(makeRange(layer, 1, 3, 0, 1)); // 反着来
    assert.ok(off);
    assert.ok(off.startOffset < off.endOffset, '反向 Range 未纠正');
    assert.equal(off.selectedText, 'BCDEFGH');
  });

  /* ── D3 滚动模式落对页 ── */
  test('D3 滚动模式 —— getPageLayer 返回对应页槽的 textLayer', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const p5 = makeLayer(S.document, ['第五页文字'], 5);
    const p30 = makeLayer(S.document, ['第三十页文字'], 30);
    S.ctx.pdfPageDivs[5] = p5.pageDiv;
    S.ctx.pdfPageDivs[30] = p30.pageDiv;

    assert.equal(S.api.getPageLayer(30), p30.layer, 'getPageLayer(30) 没拿到第 30 页的层');
    assert.equal(S.api.getPageLayer(5), p5.layer);
    assert.equal(S.api.getPageLayer(99), null, '未渲染页应返回 null 而不是别的页');
  });

  test('D3b 滚动模式 —— page=5 的批注绝不出现在 page=30 上', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const p5 = makeLayer(S.document, ['共同文字'], 5);
    const p30 = makeLayer(S.document, ['共同文字'], 30);   // 故意同文，考验按页隔离
    S.ctx.pdfPageDivs[5] = p5.pageDiv;
    S.ctx.pdfPageDivs[30] = p30.pageDiv;

    S.api.addAnno({ bookId: 'b1', page: 5, startOffset: 0, endOffset: 4, pageTextLen: 4, selectedText: '共同文字' });
    S.api.applyAnnos('b1', 30);
    assert.deepEqual(annoSpanIdx(p30.layer), [], 'page=5 的批注污染了 page=30 —— 滚动模式落错页');

    S.api.applyAnnos('b1', 5);
    assert.deepEqual(annoSpanIdx(p5.layer), [0], 'page=5 自己的批注反而没上色');
  });

  test('D3c 单页模式 —— 走 data-page 标记寻址', () => {
    const S = loadSandbox({ pdfMode: 'page' });
    const box = S.document.createElement('div');
    const p12 = makeLayer(S.document, ['单页模式文字'], 12);
    box.appendChild(p12.pageDiv);
    S.ctx.pdfPagesEl = box;
    S.ctx.pdfCurrentPage = 12;
    assert.equal(S.api.getPageLayer(12), p12.layer);
    assert.equal(S.api.getPageLayer(13), null, '单页模式下不该把当前页当成任意页');
  });

  /* ── D4 缩放复原 ── */
  test('D4 缩放 0.5 / 3 / 1 三档，命中区间完全一致', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const texts = ['前言', '关键论点', '后记'];   // full = "前言关键论点后记"，共 8 字，「关键论点」在 [2,6)
    const LEN = 8;
    S.api.addAnno({ bookId: 'b1', page: 4, startOffset: 2, endOffset: 6, pageTextLen: LEN, selectedText: '关键论点' });

    const results = [0.5, 3, 1].map((scale) => {
      const { pageDiv, layer } = makeLayer(S.document, texts, 4, scale);
      S.ctx.pdfPageDivs[4] = pageDiv;
      S.api.applyAnnos('b1', 4);
      return { scale, hit: annoSpanIdx(layer), len: S.api.buildPageIndex(layer).len };
    });
    for (const r of results) {
      eqArr(r.hit, [1], `scale=${r.scale} 时命中 ${JSON.stringify(r.hit)}，应恒为 [1]（offset 必须与缩放无关）`);
      assert.equal(r.len, LEN, `scale=${r.scale} 改变了页文本长度，坐标系被污染`);
    }
  });

  /* ── D5 显存回收后重渲 ── */
  test('D5 页被回收再重渲 —— 批注仍然复原', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const texts = ['章节标题', '正文重点', '脚注'];
    const first = makeLayer(S.document, texts, 21);
    S.ctx.pdfPageDivs[21] = first.pageDiv;
    S.ctx.pdfRendered.add(21);

    S.api.addAnno({ bookId: 'b1', page: 21, startOffset: 4, endOffset: 8, pageTextLen: 10, selectedText: '正文重点' });
    S.api.applyAnnos('b1', 21);
    assert.deepEqual(annoSpanIdx(first.layer), [1]);

    // 模拟 pdfEvictFarPages：清空页槽 + 从 pdfRendered 摘除
    delete S.ctx.pdfPageDivs[21];
    S.ctx.pdfRendered.delete(21);
    assert.equal(S.api.getPageLayer(21), null);
    S.api.applyAnnos('b1', 21);   // 未渲染时调用必须静默，不能抛

    // 重新渲染（全新 span，无任何 anno 类）
    const again = makeLayer(S.document, texts, 21);
    S.ctx.pdfPageDivs[21] = again.pageDiv;
    S.ctx.pdfRendered.add(21);
    assert.deepEqual(annoSpanIdx(again.layer), []);
    S.api.applyAnnos('b1', 21);
    assert.deepEqual(annoSpanIdx(again.layer), [1], '重渲后批注没有复原');
  });

  test('D5b repaintRenderedPages 只重绘已渲染页，且不抛', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const a = makeLayer(S.document, ['重点内容AA'], 2);
    const b = makeLayer(S.document, ['重点内容AA'], 9);
    S.ctx.pdfPageDivs[2] = a.pageDiv;
    S.ctx.pdfPageDivs[9] = b.pageDiv;
    S.ctx.pdfRendered.add(2);           // 只有第 2 页算「已渲染」
    S.ctx.pdfPagesEl = S.document.body; // repaint 要求 pagesEl 在 body 内
    S.document.body.__inBody = true;

    S.api.addAnno({ bookId: 'b1', page: 2, startOffset: 0, endOffset: 6, pageTextLen: 6, selectedText: '重点内容AA' });
    S.api.addAnno({ bookId: 'b1', page: 9, startOffset: 0, endOffset: 6, pageTextLen: 6, selectedText: '重点内容AA' });
    S.api.repaintRenderedPages('b1');
    assert.deepEqual(annoSpanIdx(a.layer), [0]);
    assert.deepEqual(annoSpanIdx(b.layer), [], '未渲染页不应被上色');
  });

  /* ── D6 幂等 / 降级 ── */
  test('D6 applyAnnos 幂等：连跑 3 次，上色与角标数量不变', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const { pageDiv, layer } = makeLayer(S.document, ['aaa', '目标文字', 'bbb'], 6);
    S.ctx.pdfPageDivs[6] = pageDiv;
    S.api.addAnno({ bookId: 'b1', page: 6, startOffset: 3, endOffset: 7, pageTextLen: 10, selectedText: '目标文字', type: 'comment', text: '评论' });
    const snap = [];
    for (let i = 0; i < 3; i++) {
      S.api.applyAnnos('b1', 6);
      snap.push([annoSpanIdx(layer).join(','), pageDiv.querySelectorAll('.anno-dot').length]);
    }
    assert.deepEqual(snap[1], snap[0], 'applyAnnos 第 2 次结果与第 1 次不同 —— 不幂等');
    assert.deepEqual(snap[2], snap[0], 'applyAnnos 第 3 次结果漂移 —— 角标会越堆越多');
    assert.equal(snap[0][1], 1, '评论型批注应恰好 1 个角标');
  });

  test('D6b 高亮型不加角标，评论/想法型才加', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const { pageDiv, layer } = makeLayer(S.document, ['aaa', 'bbb'], 6);
    S.ctx.pdfPageDivs[6] = pageDiv;
    S.api.addAnno({ bookId: 'b1', page: 6, startOffset: 0, endOffset: 3, pageTextLen: 6, selectedText: 'aaa', type: 'highlight' });
    S.api.applyAnnos('b1', 6);
    assert.equal(pageDiv.querySelectorAll('.anno-dot').length, 0);
    S.api.addAnno({ bookId: 'b1', page: 6, startOffset: 3, endOffset: 6, pageTextLen: 6, selectedText: 'bbb', type: 'idea', text: '想法' });
    S.api.applyAnnos('b1', 6);
    assert.equal(pageDiv.querySelectorAll('.anno-dot').length, 1);
  });

  test('D7 L2 降级：页文本变了（重排/OCR 差异）仍靠 selectedText 就近命中', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    // 存的 pageTextLen=99 与实际不符 → L1 失效，必须走 L2
    S.api.addAnno({ bookId: 'b1', page: 8, startOffset: 5, endOffset: 9, pageTextLen: 99, selectedText: '关键论点' });
    const { pageDiv, layer } = makeLayer(S.document, ['开头', '关键论点', '结尾'], 8);
    S.ctx.pdfPageDivs[8] = pageDiv;
    S.api.applyAnnos('b1', 8);
    assert.deepEqual(annoSpanIdx(layer), [1], 'L2 就近降级未生效 —— 页文本一变批注就丢');
  });

  test('D7b L2 多处候选时取离原 offset 最近的一处', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    // full = "XX重点YY重点ZZ"：重点在 2 和 6；原 offset 6 → 应选后者
    S.api.addAnno({ bookId: 'b1', page: 8, startOffset: 6, endOffset: 8, pageTextLen: 999, selectedText: '重点' });
    const { pageDiv, layer } = makeLayer(S.document, ['XX', '重点', 'YY', '重点', 'ZZ'], 8);
    S.ctx.pdfPageDivs[8] = pageDiv;
    S.api.applyAnnos('b1', 8);
    assert.deepEqual(annoSpanIdx(layer), [3], 'L2 没有取「就近」的那处');
  });

  test('D8 L3 静默跳过：文本找不到且 offset 非法 —— 不抛异常、不删数据', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    S.api.addAnno({ bookId: 'b1', page: 8, startOffset: 500, endOffset: 900, pageTextLen: 999, selectedText: '本页根本没有的文字' });
    const { pageDiv, layer } = makeLayer(S.document, ['短文本'], 8);
    S.ctx.pdfPageDivs[8] = pageDiv;
    assert.doesNotThrow(() => S.api.applyAnnos('b1', 8), 'L3 应静默，不应抛异常');
    assert.deepEqual(annoSpanIdx(layer), []);
    assert.equal(S.api.annosOf('b1', 8).length, 1, 'L3 不得删除数据（下次页面对上还要复原）');
  });
});

function pick(off) {
  return { startOffset: off.startOffset, endOffset: off.endOffset, pageTextLen: off.pageTextLen, selectedText: off.selectedText };
}

/* ══════════════════════════ E AnnoStore 数据链路 ══════════════════════════ */

describe('E cogAnnos 数据链路', () => {
  test('E1 cogAnnos 是顶层独立数组，不嵌在 book 下', () => {
    assert.match(HTML, /let cogAnnos = LS\.get\("wb_cog_annos", \[\]\);/);
    assert.match(HTML, /LS\.set\("wb_cog_annos", cogAnnos\)/);
    assert.equal(/b\.annos\s*=|book\.annos\s*=/.test(HTML), false, '批注被挂到 book 下了（违反顶层独立数组约定）');
  });

  test('E2 addAnno 写入 cogAnnos 并补齐契约字段', () => {
    const S = loadSandbox();
    const r = S.api.addAnno({ bookId: 'b1', page: 3, startOffset: 1, endOffset: 5, pageTextLen: 20, selectedText: 'abcd', type: 'comment', text: 'hi', color: 'green' });
    assert.ok(r.id, 'addAnno 未生成 id');
    assert.equal(S.api.cogAnnos.length, 1);
    for (const k of ['id', 'bookId', 'page', 'startOffset', 'endOffset', 'pageTextLen', 'selectedText', 'type', 'color', 'text', 'createdAt', 'updatedAt', 'deviceId', 'deleted'])
      assert.ok(k in r, `字段缺失：${k}`);
    assert.equal(r.deleted, false);
    assert.equal(r.deviceId, 'devA');
    assert.equal(S.calls.scheduleSync, 1, 'addAnno 未触发同步调度');
  });

  test('E2b 非法 type / color 回落默认值', () => {
    const S = loadSandbox();
    const r = S.api.addAnno({ bookId: 'b1', page: 1, type: 'bogus', color: 'rainbow' });
    assert.equal(r.type, 'highlight');
    assert.equal(r.color, S.api.ANNO_COLOR_DEFAULT);
  });

  test('E3 annosOf 按 bookId + page 精确过滤', () => {
    const S = loadSandbox();
    S.api.addAnno({ bookId: 'b1', page: 1 });
    S.api.addAnno({ bookId: 'b1', page: 2 });
    S.api.addAnno({ bookId: 'b2', page: 1 });
    assert.equal(S.api.annosOf('b1', 1).length, 1);
    assert.equal(S.api.annosOf('b1', null).length, 2, 'page=null 应返回全书');
    assert.equal(S.api.annosOf('b2', 1).length, 1);
    assert.equal(S.api.annoCountOfBook('b1'), 2);
    // page 用 Number 比较，字符串页码也要命中
    assert.equal(S.api.annosOf('b1', '2').length, 1, 'page 字符串/数字未归一');
  });

  test('E4 updateAnno 刷新 updatedAt + deviceId', () => {
    const S = loadSandbox();
    const a = S.api.addAnno({ bookId: 'b1', page: 1, text: 'old' });
    const t0 = a.updatedAt;
    S.ctx.deviceId = 'devB';
    const b = S.api.updateAnno(a.id, { text: 'new' });
    assert.equal(b.text, 'new');
    assert.ok(b.updatedAt >= t0);
    assert.equal(b.deviceId, 'devB', 'updateAnno 未刷新 deviceId（LWW 平局判定会失准）');
    assert.equal(S.api.updateAnno('nope', {}), null);
  });

  test('E5 removeAnno 是软删（deleted:true），annosOf 不再返回', () => {
    const S = loadSandbox();
    const a = S.api.addAnno({ bookId: 'b1', page: 1 });
    S.api.removeAnno(a.id);
    assert.equal(S.api.cogAnnos.length, 1, '软删不得从数组中物理移除（否则跨端同步会复活）');
    assert.equal(S.api.cogAnnos[0].deleted, true);
    assert.ok(S.api.cogAnnos[0].updatedAt > 0);
    assert.equal(S.api.annosOf('b1', 1).length, 0, '已软删的批注仍被 annosOf 返回');
  });

  test('E5b 软删的批注不再上色', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const { pageDiv, layer } = makeLayer(S.document, ['abc', '目标', 'def'], 1);
    S.ctx.pdfPageDivs[1] = pageDiv;
    const a = S.api.addAnno({ bookId: 'b1', page: 1, startOffset: 3, endOffset: 5, pageTextLen: 8, selectedText: '目标' });
    S.api.applyAnnos('b1', 1);
    assert.deepEqual(annoSpanIdx(layer), [1]);
    S.api.removeAnno(a.id);
    S.api.applyAnnos('b1', 1);
    assert.deepEqual(annoSpanIdx(layer), [], '删除后旧上色未被清掉（clearAnnoMarks 失效）');
  });

  test('E6 migrateHighlightsToAnnos：id 确定性 = "mg_"+旧id', () => {
    const S = loadSandbox();
    S.ctx.cogReads = [
      { id: 'r1', kind: 'annotation', sourceBookId: 'b1', page: 3, original: '原文A', understanding: '理解A', created: 111, deviceId: 'devX' },
      { id: 'r2', kind: 'annotation', sourceBookId: 'b1', page: 4, original: '原文B', created: 222 },
      { id: 'r3', kind: 'annotation', sourceBookId: 'b1', page: 5, understanding: '纯想法', created: 333 },
      { id: 'r4', kind: 'note', original: '不该被迁移' },
      { id: 'r5', kind: 'annotation', deleted: true, original: '已删' },
    ];
    const n = S.api.migrateHighlightsToAnnos();
    assert.equal(n, 3, `应迁移 3 条（kind=annotation 且未删），实际 ${n}`);
    const ids = Array.from(S.api.cogAnnos, (a) => a.id).sort();
    assert.deepEqual(ids, ['mg_r1', 'mg_r2', 'mg_r3'], 'id 不是确定性的 "mg_"+旧id —— 多端迁移会产生重复批注');
    const m1 = S.api.cogAnnos.find((a) => a.id === 'mg_r1');
    assert.equal(m1.type, 'comment', '有原文+有正文 应为 comment');
    assert.equal(m1.selectedText, '原文A');
    assert.equal(m1.startOffset, -1, '未知锚点应为 -1 以走 L2');
    assert.equal(S.api.cogAnnos.find((a) => a.id === 'mg_r2').type, 'highlight');
    assert.equal(S.api.cogAnnos.find((a) => a.id === 'mg_r3').type, 'idea');
  });

  test('E6b 迁移幂等：重复执行不产生重复记录', () => {
    const S = loadSandbox();
    S.ctx.cogReads = [{ id: 'r1', kind: 'annotation', sourceBookId: 'b1', page: 3, original: 'X', created: 1 }];
    assert.equal(S.api.migrateHighlightsToAnnos(), 1);
    assert.equal(S.api.migrateHighlightsToAnnos(), 0, '第二次迁移不应再产出');
    assert.equal(S.api.migrateHighlightsToAnnos(), 0);
    assert.equal(S.api.cogAnnos.length, 1, `重复迁移产生了 ${S.api.cogAnnos.length} 条 —— 幂等失效`);
    assert.equal(S.ctx.cogReads[0].migratedToAnno, true, '旧记录未打 migratedToAnno 标记');
  });

  test('E6c 迁移幂等（跨端）：远端已同步下 mg_ 记录时只补标记，不重复建', () => {
    const S = loadSandbox();
    // 模拟另一台设备已迁移并同步下来
    S.api.cogAnnos = [{ id: 'mg_r1', bookId: 'b1', page: 3, selectedText: 'X', type: 'highlight', deleted: false, updatedAt: 5 }];
    S.ctx.cogReads = [{ id: 'r1', kind: 'annotation', sourceBookId: 'b1', page: 3, original: 'X', created: 1 }];
    S.api.migrateHighlightsToAnnos();
    assert.equal(S.api.cogAnnos.length, 1, '跨端半迁移场景产生了重复批注');
    assert.equal(S.ctx.cogReads[0].migratedToAnno, true);
  });

  test('E6d 迁移不物理删除旧记录（可逆）', () => {
    const S = loadSandbox();
    S.ctx.cogReads = [{ id: 'r1', kind: 'annotation', sourceBookId: 'b1', page: 3, original: 'X', created: 1 }];
    S.api.migrateHighlightsToAnnos();
    assert.equal(S.ctx.cogReads.length, 1, '旧 cogReads 记录被删了 —— 迁移不可逆');
    assert.equal(S.ctx.cogReads[0].deleted, undefined);
  });

  /* ── 同步链路（静态断言到真实源码行） ── */
  test('E7 pullSync 合并 cog_annos / cog_expr', () => {
    assert.match(HTML, /cogAnnos = mergeRecords\(cogAnnos, j\.payload\.cog_annos\|\|\[\]\);/,
      'pullSync 未合并 cog_annos —— 跨端拉不到批注');
    assert.match(HTML, /cogExpr = mergeRecords\(cogExpr, j\.payload\.cog_expr\|\|\[\]\);/,
      'pullSync 未合并 cog_expr（这是本次顺带修的线上丢数据 bug，不许回退）');
  });

  test('E7b pullSync 之后触发批注重绘', () => {
    const i = HTML.indexOf('cogAnnos = mergeRecords(cogAnnos');
    const tail = HTML.slice(i, i + 2500);
    assert.match(tail, /repaintRenderedPages\(cogReadingBookId\)/, 'pullSync 后未重绘，云端批注要刷新才可见');
  });

  test('E7c pullSync 后再跑一次迁移（拉到其他端旧高亮也能转）', () => {
    const i = HTML.indexOf('cogAnnos = mergeRecords(cogAnnos');
    assert.match(HTML.slice(i, i + 1200), /migrateHighlightsToAnnos\(\)/);
  });

  test('E8 pushSync payload 含 cog_annos / cog_expr', () => {
    const line = HTML.split(/\r?\n/).find((l) => l.includes('const payload = { times, ideas, notes, diary'));
    assert.ok(line, '找不到 pushSync payload 构造');
    assert.match(line, /cog_annos:cogAnnos/, 'push payload 缺 cog_annos —— 本地批注永远上不了云');
    assert.match(line, /cog_expr:cogExpr/, 'push payload 缺 cog_expr');
  });

  test('E9 导出含 cog_annos', () => {
    const line = HTML.split(/\r?\n/).find((l) => l.includes('export_at:new Date().toISOString()'));
    assert.ok(line);
    assert.match(line, /cog_annos:cogAnnos/, '导出缺 cog_annos —— 备份丢批注');
  });

  test('E10 persistCog 落盘 cog_annos（刷新页面不丢）', () => {
    const S = loadSandbox();
    S.api.addAnno({ bookId: 'b1', page: 1, selectedText: 'x' });
    assert.ok(Array.isArray(S.calls.ls['wb_cog_annos']), 'addAnno 未落盘 wb_cog_annos');
    assert.equal(S.calls.ls['wb_cog_annos'].length, 1);
  });
});

/* ══════════════════════════ F 批注交互 ══════════════════════════ */

describe('F 批注交互层', () => {
  test('F1 showSelToolbar 渲染 5 个按钮（🖍💬💡📋✕）', () => {
    const S = loadSandbox();
    S.api.showSelToolbar({ left: 100, top: 200, width: 50, height: 20, bottom: 220, right: 150 },
      { bookId: 'b1', page: 1, startOffset: 0, endOffset: 2, pageTextLen: 10, selectedText: 'ab' });
    const row = S.document.querySelector('.pdf-sel-row');
    assert.ok(row, '选中工具栏未插入 DOM');
    for (const a of ['hl', 'cm', 'id', 'dict', 'tr', 'cp', 'x'])
      assert.ok(row.querySelector(`[data-a="${a}"]`), `工具栏缺按钮 data-a="${a}"`);
    assert.equal(row.querySelectorAll('button').length, 7, '工具栏按钮数应为 7');
  });

  test('F1b 三种浮层都是 position:fixed（absolute 在滚动容器里会飘）', () => {
    const css = HTML.slice(0, HTML.indexOf('</style>'));
    for (const sel of ['.pdf-sel-row', '.anno-pop', '.book-menu']) {
      const i = css.indexOf(sel + '{');
      assert.notEqual(i, -1, `缺少 ${sel} 样式`);
      assert.match(css.slice(i, i + 120), /position:\s*fixed/, `${sel} 不是 fixed 定位`);
    }
  });

  test('F1c placeFloatAbove 把浮层夹取进视口（右下角选中不越界）', () => {
    const S = loadSandbox();
    const el = S.document.createElement('div');
    el.__ow = 300; el.__oh = 60;
    // 贴着右上角选中：横向会溢出右边、纵向上方放不下需翻到下方
    S.api.placeFloatAbove(el, { left: 990, top: 5, bottom: 25, width: 10, height: 20, right: 1000 });
    const L = parseFloat(el.style.left), T = parseFloat(el.style.top);
    assert.ok(L >= 0 && L + 300 <= S.window.innerWidth, `left=${L} 越出视口右边界`);
    assert.ok(T >= 8, `top=${T} 越出视口上边界（上方放不下时应翻到下方）`);
    assert.ok(T > 25, '上方空间不足时未翻到锚点下方');

    // 贴着左下角选中：横向不能为负，纵向应落在锚点上方
    S.api.placeFloatAbove(el, { left: 0, top: 700, bottom: 720, width: 10, height: 20, right: 10 });
    assert.ok(parseFloat(el.style.left) >= 8, '左边界未夹取');
    assert.ok(parseFloat(el.style.top) < 700, '上方有空间时应显示在锚点上方');
  });

  test('F2 点 🖍高亮 → addAnno 落库', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const draft = { bookId: 'b1', page: 2, startOffset: 0, endOffset: 2, pageTextLen: 10, selectedText: 'ab' };
    S.setSelection({ removeAllRanges() {} });
    S.api.showSelToolbar({ left: 10, top: 10, width: 10, height: 10, bottom: 20, right: 20 }, draft);
    S.document.querySelector('[data-a="hl"]').dispatch('click');
    assert.equal(S.api.cogAnnos.length, 1, '点高亮没写入批注');
    assert.equal(S.api.cogAnnos[0].type, 'highlight');
    assert.equal(S.document.querySelector('.pdf-sel-row'), null, '高亮后工具栏未关闭');
  });

  test('F3 bindPdfSelection：对模拟 selection 弹出工具栏', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const { pageDiv, layer } = makeLayer(S.document, ['选中我', '其余'], 2);
    S.ctx.pdfPageDivs[2] = pageDiv;
    const pagesEl = S.document.createElement('div');
    pagesEl.id = 'pdfPages';
    pagesEl.appendChild(pageDiv);
    S.document.body.appendChild(pagesEl);

    S.setSelection({
      isCollapsed: false, rangeCount: 1,
      getRangeAt: () => makeRange(layer, 0, 0, 0, 3),
      removeAllRanges() {},
      toString: () => '选中我',
    });
    S.api.bindPdfSelection(pagesEl, { id: 'b1' });
    pagesEl.dispatch('mouseup');
    S.flushTimers();
    const row = S.document.querySelector('.pdf-sel-row');
    assert.ok(row, 'mouseup 后未弹出选中工具栏');
  });

  test('F3b 选区为空 / 折叠时不弹工具栏', () => {
    const S = loadSandbox();
    const pagesEl = S.document.createElement('div');
    S.document.body.appendChild(pagesEl);
    S.setSelection({ isCollapsed: true, rangeCount: 0 });
    S.api.bindPdfSelection(pagesEl, { id: 'b1' });
    pagesEl.dispatch('mouseup');
    S.flushTimers();
    assert.equal(S.document.querySelector('.pdf-sel-row'), null, '空选区不应弹工具栏');
  });

  test('F4 #pdfPages 事件委托：点 span.anno[data-anno-id] → openAnnoPopover', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const { pageDiv, layer } = makeLayer(S.document, ['abc', '被批注', 'def'], 2);
    S.ctx.pdfPageDivs[2] = pageDiv;
    const pagesEl = S.document.createElement('div');
    pagesEl.appendChild(pageDiv);
    S.document.body.appendChild(pagesEl);

    const a = S.api.addAnno({ bookId: 'b1', page: 2, startOffset: 3, endOffset: 6, pageTextLen: 9, selectedText: '被批注', type: 'comment', text: '我的评论' });
    S.api.applyAnnos('b1', 2);
    const hit = layer.children[1];
    assert.equal(hit.dataset.annoId, a.id, '上色 span 未写 data-anno-id（事件委托无法命中）');

    S.api.bindPdfSelection(pagesEl, { id: 'b1' });
    pagesEl.dispatch('click', { target: hit });
    const pop = S.document.querySelector('.anno-pop');
    assert.ok(pop, '点击批注文字没有弹出气泡');
    assert.match(pop.innerHTML, /我的评论/, '气泡未显示批注正文');
  });

  test('F4b 事件委托同样命中 .anno-dot 角标', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const { pageDiv, layer } = makeLayer(S.document, ['abc', '被批注'], 2);
    S.ctx.pdfPageDivs[2] = pageDiv;
    const pagesEl = S.document.createElement('div');
    pagesEl.appendChild(pageDiv);
    S.document.body.appendChild(pagesEl);
    S.api.addAnno({ bookId: 'b1', page: 2, startOffset: 3, endOffset: 6, pageTextLen: 6, selectedText: '被批注', type: 'idea', text: '一个想法' });
    S.api.applyAnnos('b1', 2);
    const dot = pageDiv.querySelector('.anno-dot');
    assert.ok(dot, '想法型未生成角标');
    S.api.bindPdfSelection(pagesEl, { id: 'b1' });
    pagesEl.dispatch('click', { target: dot });
    assert.ok(S.document.querySelector('.anno-pop'), '点角标未弹气泡');
  });

  test('F4c 点普通文字（非批注）不弹气泡', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    const { pageDiv, layer } = makeLayer(S.document, ['普通文字'], 2);
    const pagesEl = S.document.createElement('div');
    pagesEl.appendChild(pageDiv);
    S.document.body.appendChild(pagesEl);
    S.api.bindPdfSelection(pagesEl, { id: 'b1' });
    pagesEl.dispatch('click', { target: layer.children[0] });
    assert.equal(S.document.querySelector('.anno-pop'), null);
  });

  test('F5 openAnnoEditor 契约：新建态 / 编辑态', () => {
    const S = loadSandbox();
    mountEditorModal(S);
    S.api.openAnnoEditor({ bookId: 'b1', page: 1, selectedText: 'quoted', type: 'idea' });
    assert.equal(S.ctx.$('#aeTitle').textContent, '💡 写想法');
    assert.match(S.ctx.$('#aeQuote').textContent, /quoted/);
    assert.equal(S.ctx.$('#aeDelete').style.display, 'none', '新建态不应显示删除按钮');
    assert.ok(S.ctx.$('#annoEditorModal').classList.contains('open'));

    const a = S.api.addAnno({ bookId: 'b1', page: 1, selectedText: 'S', type: 'comment', text: 'body' });
    S.api.openAnnoEditor({ annoId: a.id });
    assert.equal(S.ctx.$('#aeText').value, 'body', '编辑态未回填正文');
    assert.equal(S.ctx.$('#aeDelete').style.display, '', '编辑态应显示删除按钮');
  });

  test('F5b saveAnnoEditor 新建 → 入库；编辑 → 更新不新增', () => {
    const S = loadSandbox();
    mountEditorModal(S);
    S.api.openAnnoEditor({ bookId: 'b1', page: 1, selectedText: 'S', type: 'comment' });
    S.ctx.$('#aeText').value = '第一条';
    S.api.saveAnnoEditor();
    assert.equal(S.api.cogAnnos.length, 1);
    const id = S.api.cogAnnos[0].id;

    S.api.openAnnoEditor({ annoId: id });
    S.ctx.$('#aeText').value = '改过了';
    S.api.saveAnnoEditor();
    assert.equal(S.api.cogAnnos.length, 1, '编辑态却新增了一条 —— 会产生重复批注');
    assert.equal(S.api.cogAnnos[0].text, '改过了');
  });

  test('F5c deleteAnnoEditor 软删', () => {
    const S = loadSandbox();
    mountEditorModal(S);
    const a = S.api.addAnno({ bookId: 'b1', page: 1, selectedText: 'S', type: 'comment', text: 'x' });
    S.api.openAnnoEditor({ annoId: a.id });
    S.api.deleteAnnoEditor();
    assert.equal(S.api.cogAnnos[0].deleted, true);
  });

  test('F6 openAnnoPopover：已删批注不弹；关闭可复位', () => {
    const S = loadSandbox();
    const a = S.api.addAnno({ bookId: 'b1', page: 1, selectedText: 'S', type: 'comment', text: 'body' });
    const anchor = S.document.createElement('span');
    S.api.openAnnoPopover(a.id, anchor);
    assert.ok(S.document.querySelector('.anno-pop'));
    S.api.closeAnnoPopover();
    assert.equal(S.document.querySelector('.anno-pop'), null);

    S.api.removeAnno(a.id);
    S.api.openAnnoPopover(a.id, anchor);
    assert.equal(S.document.querySelector('.anno-pop'), null, '已删批注不应还能弹气泡');
  });

  test('F6b 气泡带 编辑 / 删除 / 关闭 三个操作', () => {
    const S = loadSandbox();
    const a = S.api.addAnno({ bookId: 'b1', page: 1, selectedText: 'S', type: 'comment', text: 'body' });
    S.api.openAnnoPopover(a.id, S.document.createElement('span'));
    const pop = S.document.querySelector('.anno-pop');
    for (const act of ['edit', 'del', 'x'])
      assert.ok(pop.querySelector(`[data-a="${act}"]`), `气泡缺操作 ${act}`);
  });

  test('F7 旧 openCogAnno 系列仍在（英文表达链路未被破坏）', () => {
    for (const fn of ['openCogAnno', 'saveCogAnno', 'closeCogAnno'])
      assert.ok(new RegExp(`function ${fn}\\s*\\(`).test(HTML), `${fn} 定义丢失 —— 英文表达链路被误删`);
  });

  test('F8 屏6 批注列表数据源已切到 cogAnnos', () => {
    const i = HTML.indexOf('function renderCogAnno(');
    assert.notEqual(i, -1, 'renderCogAnno 丢失');
    const body = HTML.slice(i, i + 3000);
    assert.match(body, /cogAnnos|annosOf\(/, '屏6 未切到 cogAnnos 数据源');
  });
});

function mountEditorModal(S) {
  const mk = (id, tag = 'div') => { const e = S.document.createElement(tag); e.setAttribute('id', id); S.document.body.appendChild(e); return e; };
  mk('annoEditorModal'); mk('aeTitle'); mk('aeQuote'); mk('aeColors');
  const t = mk('aeText', 'textarea'); t.value = '';
  mk('aeDelete', 'button');
}

/* ══════════════════════════ G 书架重构 ══════════════════════════ */

describe('G 小说风书架（T04）', () => {
  const book = (o) => ({ id: 'b1', title: '深度工作', author: '纽波特', deleted: false, updatedAt: 1, ...o });

  test('G1 renderCogShelf 产出 .book-card / .book-cover 竖版结构（非旧横条）', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    const box = S.document.createElement('div');
    S.document.body.appendChild(box);
    S.api.renderCogShelf(box, 0, false);
    assert.match(box.innerHTML, /class="book-card"/, '书架未产出 .book-card');
    assert.match(box.innerHTML, /class="book-cover"/, '书架未产出 .book-cover');
    assert.match(box.innerHTML, /data-book="b1"/);
  });

  test('G1b 封面 2:3 竖版比例由 CSS aspect-ratio 承载', () => {
    const css = HTML.slice(0, HTML.indexOf('</style>'));
    const i = css.indexOf('.book-cover');
    assert.notEqual(i, -1, '缺少 .book-cover 样式');
    assert.match(css.slice(i, i + 500), /aspect-ratio\s*:\s*2\s*\/\s*3/, '.book-cover 未设置 2/3 竖版比例');
  });

  test('G2 进度条 + 批注徽标按数据条件渲染', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({ lastPage: 50, totalPages: 200 })];
    S.api.addAnno({ bookId: 'b1', page: 1 });
    S.api.addAnno({ bookId: 'b1', page: 2 });
    const box = S.document.createElement('div');
    S.api.renderCogShelf(box, 0, false);
    assert.match(box.innerHTML, /class="bc-bar" style="width:25%"/, '进度条比例算错（50/200 应为 25%）');
    assert.match(box.innerHTML, /book-badge">📝 2</, '批注徽标数量不对');
    assert.match(box.innerHTML, /读到第 50 页/, '未显示续读页码');
  });

  test('G2b 无进度 / 无批注时不渲染进度条与徽标（视觉不噪音）', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    const box = S.document.createElement('div');
    S.api.renderCogShelf(box, 0, false);
    assert.equal(/bc-bar/.test(box.innerHTML), false);
    assert.equal(/book-badge/.test(box.innerHTML), false);
  });

  test('G2c bookProgressOf：优先按页码算，无页码回落 progress 字段，且夹取 0-100', () => {
    const S = loadSandbox();
    assert.equal(S.api.bookProgressOf({ lastPage: 5, totalPages: 10 }), 50);
    assert.equal(S.api.bookProgressOf({ progress: 33 }), 33);
    assert.equal(S.api.bookProgressOf({ lastPage: 20, totalPages: 10 }), 100, '未夹取上界');
    assert.equal(S.api.bookProgressOf({ progress: -5 }), 0, '未夹取下界');
    assert.equal(S.api.bookProgressOf(null), 0);
  });

  test('G3 点封面 → openBookReader（不再进详情弹窗）', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    const box = S.document.createElement('div');
    S.document.body.appendChild(box);
    S.api.renderCogShelf(box, 0, false);
    box.querySelector('.book-card').dispatch('click');
    assert.ok(S.calls.render.includes('reader:b1'), `点封面未调 openBookReader，实际：${JSON.stringify(S.calls.render)}`);
  });

  test('G3b openBookReader 直进 PDF 并跳 lastPage（源码契约）', () => {
    assert.match(HTML, /function openBookReader\(bookId\)\{[^}]*openCogReadingSpace\(bookId\)/,
      'openBookReader 未走 openCogReadingSpace');
    const i = HTML.indexOf('function openCogReadingSpace(');
    assert.notEqual(i, -1);
    const body = HTML.slice(i, i + 1600);
    assert.match(body, /setCogScreen\(5\)/, '未切到阅读空间屏5');
    assert.match(body, /renderPdfBook|renderCogReadingFile/, '有文件时未进 PDF 渲染链路');
    assert.match(HTML, /pdfJumpTo|lastPage/, '未接续读页');
  });

  test('G4 长按 600ms → openBookMenu，且抑制随后的 click', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    const box = S.document.createElement('div');
    S.document.body.appendChild(box);
    S.api.renderCogShelf(box, 0, false);
    const card = box.querySelector('.book-card');

    card.dispatch('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
    S.flushTimers();                       // 触发 600ms 长按定时器
    assert.ok(S.document.querySelector('.book-menu'), '长按未弹出书籍菜单');
    assert.equal(S.api.suppressBookClick, true, '长按后未置抑制标志');

    S.calls.render.length = 0;
    card.dispatch('click');
    assert.equal(S.calls.render.includes('reader:b1'), false, '长按后紧跟的 click 未被抑制 —— 会误跳进阅读器');
  });

  test('G4b 抑制标志在 150ms 后自动解除，之后点击正常', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    const box = S.document.createElement('div');
    S.api.renderCogShelf(box, 0, false);
    const card = box.querySelector('.book-card');
    card.dispatch('touchstart', { touches: [{ clientX: 1, clientY: 1 }] });
    S.flushTimers();                        // 长按触发 + 排入 150ms 解除定时器
    assert.equal(S.api.suppressBookClick, true);
    S.flushTimers();                        // 解除
    assert.equal(S.api.suppressBookClick, false, '抑制标志未自动解除（此后永远点不动书架）');
    S.calls.render.length = 0;
    card.dispatch('click');
    assert.ok(S.calls.render.includes('reader:b1'));
  });

  test('G4c 长按中手指滑动 >10px 取消长按', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    const box = S.document.createElement('div');
    S.api.renderCogShelf(box, 0, false);
    const card = box.querySelector('.book-card');
    card.dispatch('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
    card.dispatch('touchmove', { touches: [{ clientX: 100, clientY: 140 }] });
    S.flushTimers();
    assert.equal(S.document.querySelector('.book-menu'), null, '滑动后仍触发了长按菜单（滚动书架会误弹）');
  });

  test('G4d 右键 contextmenu 也能开菜单', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    const box = S.document.createElement('div');
    S.api.renderCogShelf(box, 0, false);
    box.querySelector('.book-card').dispatch('contextmenu', { clientX: 50, clientY: 60 });
    assert.ok(S.document.querySelector('.book-menu'), '右键未开菜单');
  });

  test('G5 openBookMenu 含 继续/信息/批注/换封面/删除 五项', () => {
    const S = loadSandbox();
    S.ctx.cogBooks = [book({})];
    S.api.openBookMenu('b1', 10, 10);
    const m = S.document.querySelector('.book-menu');
    for (const act of ['read', 'info', 'anno', 'cover', 'del'])
      assert.ok(m.querySelector(`[data-act="${act}"]`), `书籍菜单缺项 ${act}`);
    assert.equal(m.querySelectorAll('button').length, 5);
  });

  test('G5b 菜单位置夹取在视口内', () => {
    const S = loadSandbox();
    const m = S.document.createElement('div');
    m.__ow = 200; m.__oh = 240;
    S.api.clampFixed(m, 9999, 9999);
    assert.ok(parseFloat(m.style.left) + 200 <= S.window.innerWidth, '菜单越出右边界');
    assert.ok(parseFloat(m.style.top) + 240 <= S.window.innerHeight, '菜单越出下边界');
    S.api.clampFixed(m, -500, -500);
    assert.ok(parseFloat(m.style.left) >= 0 && parseFloat(m.style.top) >= 0, '菜单越出左/上边界');
  });

  test('G6 delCogBook 级联软删该书 cogAnnos（源码契约）', () => {
    const i = HTML.indexOf('async function delCogBook(){');
    assert.notEqual(i, -1, 'delCogBook 丢失');
    const body = HTML.slice(i, HTML.indexOf('function closeCogBook(', i));
    assert.match(body, /cogAnnos = cogAnnos\.map\(/, 'delCogBook 未级联处理 cogAnnos —— 会留孤儿批注');
    assert.match(body, /a\.bookId===delId[^]*?deleted:true/, '级联删除未按 bookId 且未走软删');
    assert.match(body, /persistAnnos\(\)/, '级联软删后未落盘');
  });

  test('G6b 级联软删真跑：只删该书的，其他书不受影响', () => {
    const S = loadSandbox();
    const delId = 'b1';
    S.api.addAnno({ bookId: 'b1', page: 1 });
    S.api.addAnno({ bookId: 'b1', page: 2 });
    S.api.addAnno({ bookId: 'b2', page: 1 });
    // 复刻 delCogBook 里的级联语句（源码契约已由 G6 静态守住）
    S.api.cogAnnos = S.api.cogAnnos.map((a) =>
      (a.bookId === delId && !a.deleted) ? Object.assign({}, a, { deleted: true, updatedAt: Date.now() }) : a);
    assert.equal(S.api.annosOf('b1', null).length, 0, '该书批注未被软删');
    assert.equal(S.api.annosOf('b2', null).length, 1, '误删了别的书的批注');
    assert.equal(S.api.cogAnnos.length, 3, '级联删除做成了物理删除');
  });

  test('G7 setCogScreen 用 --cog-n 解耦屏位，COG_SCREEN_COUNT=9', () => {
    const S = loadSandbox();
    const track = S.document.createElement('div');
    track.setAttribute('id', 'cogTrack');
    S.document.body.appendChild(track);
    assert.equal(S.api.COG_SCREEN_COUNT, 9);
    S.api.setCogScreen(8);
    assert.equal(track.style.getPropertyValue('--cog-n'), '9', '未写入 --cog-n CSS 变量');
    assert.equal(track.style.transform, 'translateX(-' + (8 * 100 / 9) + '%)', '屏位位移算错');
    assert.ok(track.classList.contains('show-8'));
    // 越界夹取
    S.api.setCogScreen(99);
    assert.equal(S.ctx.cogScreen, 8, '屏位未夹取上界');
    S.api.setCogScreen(-5);
    assert.equal(S.ctx.cogScreen, 0, '屏位未夹取下界');
  });

  test('G7b CSS 侧宽度也由 --cog-n 驱动（无硬编码 9 屏魔数）', () => {
    const css = HTML.slice(0, HTML.indexOf('</style>'));
    assert.match(css, /var\(--cog-n/, 'CSS 未使用 --cog-n 变量');
    assert.equal(/transform:\s*translateX\(-\d+%\)/.test(css.slice(css.indexOf('#cogTrack'), css.indexOf('#cogTrack') + 3000)), false,
      'CSS 里仍有硬编码 translateX 屏位（加屏又会漏改）');
  });

  test('G8 屏8 书籍信息：openBookInfo → setCogScreen(8) + renderBookInfo', () => {
    const i = HTML.indexOf('function openBookInfo(');
    assert.notEqual(i, -1, 'openBookInfo 丢失');
    const body = HTML.slice(i, i + 500);
    assert.match(body, /setCogScreen\(8\)/, '书籍信息未落在屏8');
    assert.match(body, /renderBookInfo\(\)/);
    assert.match(HTML, /function renderBookInfo\(\)\{/);
  });

  test('G9 saveBookProgress 同时补写 lastPage / progress / totalPages', () => {
    const i = HTML.indexOf('function saveBookProgress(b, n){');
    assert.notEqual(i, -1, 'saveBookProgress 丢失');
    const body = HTML.slice(i, i + 900);
    assert.match(body, /b\.lastPage\s*=\s*n/, '未写 lastPage');
    assert.match(body, /b\.totalPages/, '未写 totalPages（书架进度条会算不出来）');
    assert.match(body, /b\.progress/, '未写 progress');
  });
});

/* ══════════════════════════ H 既有功能未被破坏 ══════════════════════════ */

describe('H 既有功能未被破坏', () => {
  const MUST = [
    'buildTextLayer', 'renderPage', 'renderScrollPage', 'saveBookProgress', 'pdfGoToPage',
    'setupScrollSpy', 'applyAnnos', 'mergeRecords', 'openPdfCacheDB', 'pdfCacheGet', 'pdfCachePut',
    'syncPdfScale', 'pdfDprFor', 'pdfEvictFarPages', 'renderCogShelf', 'renderCogHome',
    'renderCogBooks', 'renderCogAnno', 'saveCogProgress', 'renderCogReadingFile',
  ];
  for (const fn of MUST) {
    test(`H-${fn} 仍有定义`, () => {
      assert.ok(new RegExp(`function ${fn}\\s*\\(`).test(HTML), `${fn} 定义丢失`);
    });
  }

  test('H1 applyAnnos 调用点齐全：renderPage / renderScrollPage / afterAnnoChange / pullSync', () => {
    const at = (name, end) => {
      const i = HTML.indexOf(name);
      assert.notEqual(i, -1, `找不到 ${name}`);
      return HTML.slice(i, end ? HTML.indexOf(end, i) : i + 4000);
    };
    assert.match(at('async function renderPage(', 'async function renderScrollPage('), /applyAnnos\(b\.id,\s*n\)/,
      'renderPage 末尾未调 applyAnnos —— 单页模式翻页后批注不上色');
    assert.match(at('async function renderScrollPage(', 'function setupScrollSpy('), /applyAnnos\(b\.id,\s*n\)/,
      'renderScrollPage 末尾未调 applyAnnos —— 滚动到新页批注不上色');
    assert.match(at('function afterAnnoChange('), /applyAnnos\(bookId, page\)|repaintRenderedPages\(bookId\)/,
      'afterAnnoChange 未重绘');
    assert.match(HTML, /repaintRenderedPages\(cogReadingBookId\)/, 'pullSync 后未重绘');
  });

  test('H2 mergeRecords 语义未变（LWW by updatedAt，平局 deviceId 大者胜）', () => {
    const i = HTML.indexOf('function mergeRecords(');
    const body = HTML.slice(i, i + 900);
    assert.match(body, /updatedAt/);
    assert.match(body, /deviceId/);
  });

  test('H3 PDF 状态变量齐全（滚动/单页双模式基座）', () => {
    for (const v of ['pdfMode', 'pdfPageDivs', 'pdfRendered', 'pdfVisible', 'pdfCurrentPage', 'pdfPagesEl'])
      assert.ok(HTML.includes(v), `状态变量 ${v} 丢失`);
    assert.match(HTML, /let pdfMode='scroll'/, '默认阅读模式被改回单页（应为 scroll）');
  });

  test('H4 buildTextLayer 新增 page 参数且写入 data-page（锚定寻址依赖它）', () => {
    assert.match(HTML, /function buildTextLayer\(textContent, viewport, page\)\{/);
    assert.match(HTML, /container\.dataset\.page = page/);
    const calls = HTML.match(/buildTextLayer\(textContent,\s*lVp,\s*n\)/g) || [];
    assert.equal(calls.length, 2, `buildTextLayer 调用点应传页码，实际匹配 ${calls.length} 处`);
  });

  test('H5 buildTextLayer 真跑：产出的层能直接作为锚定坐标系', () => {
    const S = loadSandbox();
    const vp = { width: 600, height: 800, scale: 1, transform: [1, 0, 0, 1, 0, 0] };
    const tc = { items: [{ str: '你好', width: 20, transform: [1, 0, 0, 1, 0, 0] }, { str: '世界', width: 20, transform: [1, 0, 0, 1, 20, 0] }] };
    const layer = S.api.buildTextLayer(tc, vp, 11);
    assert.equal(layer.className, 'textLayer');
    assert.equal(layer.dataset.page, '11');
    const idx = S.api.buildPageIndex(layer);
    assert.equal(idx.full, '你好世界');
    eqArr(idx.starts, [0, 2]);
  });

  test('H6 空串 item 被跳过，不污染 offset 坐标系', () => {
    const S = loadSandbox();
    const vp = { width: 600, height: 800, scale: 1, transform: [1, 0, 0, 1, 0, 0] };
    const tc = { items: [{ str: 'A', width: 5, transform: [1, 0, 0, 1, 0, 0] }, { str: '', width: 0, transform: [1, 0, 0, 1, 5, 0] }, { str: 'B', width: 5, transform: [1, 0, 0, 1, 10, 0] }] };
    const idx = S.api.buildPageIndex(S.api.buildTextLayer(tc, vp, 1));
    assert.equal(idx.full, 'AB');
    assert.equal(idx.len, 2);
  });

  test('H7 未渲染页 / 空层调用 applyAnnos 全部静默不抛', () => {
    const S = loadSandbox({ pdfMode: 'scroll' });
    assert.doesNotThrow(() => S.api.applyAnnos('b1', 999));
    assert.doesNotThrow(() => S.api.applyAnnos('b1', null));
    assert.doesNotThrow(() => S.api.applyAnnos(null, 1));
    const { pageDiv } = makeLayer(S.document, [], 1);   // 空层
    S.ctx.pdfPageDivs[1] = pageDiv;
    assert.doesNotThrow(() => S.api.applyAnnos('b1', 1));
  });
});
