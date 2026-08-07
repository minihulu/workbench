/**
 * 待办/行动系统「矩阵式重设计」独立验证 —— 回归 + 新增专项
 *
 * 背景：工程师把上周的「看板（Kanban）」整块删除，替换为
 *   - 矩阵式布局（renderMatrix / matrixRowHtml / matrixCardHtml，行=方向，首行「📥 未归类」）
 *   - 时间线「今日聚焦」（renderActFocus + isInFocusToday）
 *   - 完成日历（renderTodoCalendar / renderDayCompletions）
 * 仅改 workbench.html / index.html（字节级一致），server.py 未动。
 * 完成记录嵌套进 notes.completions（零后端改动）。
 *
 * 策略（与 pdf-* / todo-goals 一致）：从 workbench.html 按标记抽取「真实源码片段」，
 * 放进带 mini-DOM / document / 存储 mock 的 vm 沙箱里真跑，断言线上代码本身。
 *
 * 覆盖：
 *   1 数据层纯函数（真实抽出切片真跑）：normNote / isInFocusToday / toggleCompletion /
 *     getCompletionMap / getCompletionsByDate / daysBetween
 *   2 矩阵渲染结构（真实抽出 renderMatrix / matrixRowHtml 真跑）：首行未归类 + 方向行、卡片结构
 *   3 完成/撤销写回（applyToggleCompletion：completions 嵌进 notes，非顶层新键）
 *   4 日历结构（真实抽出 renderTodoCalendar / renderDayCompletions 真跑）：月视图 + 点日下钻
 *   5 静态红线：renderKanban 已彻底移除；renderMatrix/matrixRowHtml/renderTodoCalendar/
 *     renderDayCompletions 已落地；📥 未归类 文案仍在
 *   6 镜像一致：workbench.html 与 index.html 字节级一致
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

/* ══════════════════════════ 源码抽取 ══════════════════════════ */

function sliceBetween(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `抽取失败：找不到起始标记 ${label} → ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.notEqual(b, -1, `抽取失败：找不到结束标记 ${label} → ${endMarker}`);
  return src.slice(a, b);
}

// 数据层：normNote（含 startDate/endDate/completions 补齐）
const R_NORMNOTE = sliceBetween(HTML, 'function normNote(n){', 'notes = notes.map(normNote);', 'normNote');
// 数据层：今日聚焦 + 完成纯函数
const R_FOCUS = sliceBetween(HTML, 'function isInFocusToday(note, today){', 'function etaLabel(m){', 'focus');
// 虚拟「📥 未归类」常量
const R_INBOX = sliceBetween(HTML, 'const GOAL_INBOX = { id:"__inbox__"', 'function normReview(', 'GOAL_INBOX');
// 矩阵渲染：matrixDateRange(状态) → getDirNotes → matrixCardHtml → matrixRowHtml → renderMatrix → bindMatrix → applyToggleCompletion
const R_MATRIX = sliceBetween(HTML, 'let matrixDateRange = new Set();', 'function renderTodoCalendar(){', 'matrix');
// 完成日历：renderTodoCalendar → bindTodoCalendar → renderDayCompletions
const R_CALENDAR = sliceBetween(HTML, 'function renderTodoCalendar(){', 'function openGoal(gid){', 'calendar');

/* 抽取边界自检：区块必须真的含被测函数 */
assert.ok(R_NORMNOTE.includes('function normNote(n){'), 'normNote 区块异常');
assert.ok(R_FOCUS.includes('function toggleCompletion(note, date){'), 'focus 区块缺少 toggleCompletion');
assert.ok(R_FOCUS.includes('function getCompletionMap(allNotes){'), 'focus 区块缺少 getCompletionMap');
assert.ok(R_MATRIX.includes('function renderMatrix(){'), 'matrix 区块缺少 renderMatrix');
assert.ok(R_MATRIX.includes('function applyToggleCompletion(id, date){'), 'matrix 区块缺少 applyToggleCompletion');
assert.ok(R_CALENDAR.includes('function renderDayCompletions(date){'), 'calendar 区块缺少 renderDayCompletions');

/* 重构红线（静态）：看板已彻底移除，矩阵/日历已落地 */
assert.ok(!/function renderKanban\(/.test(HTML), '旧看板 renderKanban 应已彻底移除（被矩阵取代）');
assert.ok(!/kanbanColumnHtml/.test(HTML), '旧看板 kanbanColumnHtml 应已彻底移除');
assert.ok(HTML.includes('function renderMatrix()'), '矩阵 renderMatrix 应已落地');
assert.ok(HTML.includes('function matrixRowHtml'), 'matrixRowHtml 应存在');
assert.ok(HTML.includes('function getCompletionMap'), '完成聚合 getCompletionMap 应存在');
assert.ok(HTML.includes('function renderTodoCalendar()'), 'renderTodoCalendar 应已落地');
assert.ok(HTML.includes('function renderDayCompletions'), 'renderDayCompletions 应已落地');
assert.ok(HTML.includes('📥 未归类'), '矩阵首行未归类文案缺失');

/* ══════════════════════════ mini-DOM / 存储 mock ══════════════════════════ */

function makeEl(tag = 'div') {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    style: { cssText: '', display: '', width: '', height: '' },
    dataset: {}, children: [], parentNode: null,
    textContent: '', value: '', _html: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { if (force === undefined) force = !classes.has(c); force ? classes.add(c) : classes.delete(c); return force; },
    },
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    focus() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = String(v); el.children.length = 0; },
  });
  return el;
}

const TODAY = '2026-08-08';

/**
 * 构建 vm 沙箱：notes / directions 由测试注入；真实源码区块（数据层 + 矩阵 + 日历）+
 * 全量 stub（isVirtualGoal / PRIO_RANK / todayStr / esc / fmtDate / $ / saveNotes / openNoteEdit）。
 * 返回 { api, calls, els, matrixWrap, todoCal, calDayView }：api.get/set 读写模块级绑定。
 */
function makeSandbox({ notes = [], directions = [] } = {}) {
  const calls = { saveNotes: 0, openNoteEdit: 0, toast: [] };
  const els = {};
  const matrixWrap = makeEl(); els['#matrixWrap'] = matrixWrap;
  const todoCal = makeEl();
  const calDayView = makeEl();
  todoCal.querySelector = (sel) => (sel === '#calDayView' ? calDayView : null);
  els['#todoCal'] = todoCal;

  const sandbox = {
    console, Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number,
    Date, parseFloat, parseInt, isNaN, RegExp,
    notes, directions,
    // 展示/交互辅助（不在抽取区块内，提供 faithful stub）
    isVirtualGoal: (x) => (typeof x === 'object' ? (x && x.id) : x) === '__inbox__',
    PRIO_RANK: { high: 0, mid: 1, low: 2 },
    todayStr: () => TODAY,
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    fmtDate: (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); },
    $: (sel) => (els[sel] || (els[sel] = makeEl())),
    $$: () => [],
    saveNotes() { calls.saveNotes++; },
    openNoteEdit() { calls.openNoteEdit++; },
    toast: (m) => calls.toast.push(m),
    __calls: calls,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const epilogue = `
    globalThis.__api = {
      get: (k) => eval(k),
      set: (k, v) => { eval(k + ' = v'); },
    };
  `;

  vm.runInContext(
    [R_NORMNOTE, R_FOCUS, R_INBOX, R_MATRIX, R_CALENDAR, epilogue].join('\n'),
    sandbox,
    { filename: 'todo-timeline.js' }
  );

  return { api: sandbox.__api, calls, els, matrixWrap, todoCal, calDayView };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

/* ══════════════════════════ 1. normNote 兼容（补齐默认，不删旧字段） ══════════════════════════ */

describe('1. normNote：旧 note 补齐 startDate/endDate/completions 默认，且不删旧字段', () => {
  function normNoteInSandbox(n) {
    const env = makeSandbox();
    return plain(env.api.get(`normNote(${JSON.stringify(n)})`));
  }
  test('N1 旧 note（无 startDate/endDate/completions）→ 补齐 null / null / []', () => {
    const out = normNoteInSandbox({ id: 'n1', title: '老任务', cat: '医学', status: 'todo' });
    assert.equal(out.startDate, null);
    assert.equal(out.endDate, null);
    assert.deepEqual(out.completions, []);
  });
  test('N2 不删旧字段：title/cat/status/dir 原样保留', () => {
    const out = normNoteInSandbox({ id: 'n1', title: '老任务', cat: '医学', status: 'doing', dir: 'g1', prio: 'high' });
    assert.equal(out.title, '老任务');
    assert.equal(out.cat, '医学');
    assert.equal(out.status, 'doing');
    assert.equal(out.dir, 'g1');
    assert.equal(out.prio, 'high');
  });
  test('N3 completions 数组自动去重（旧数据若带重复日期）', () => {
    const out = normNoteInSandbox({ id: 'n1', title: 'x', completions: ['2026-08-01', '2026-08-01', '2026-08-02'] });
    assert.deepEqual(out.completions, ['2026-08-01', '2026-08-02']);
  });
  test('N4 已有 startDate/endDate/completions 原样保留（不覆盖）', () => {
    const out = normNoteInSandbox({ id: 'n1', title: 'x', startDate: '2026-08-01', endDate: '2026-08-10', completions: ['2026-08-03'] });
    assert.equal(out.startDate, '2026-08-01');
    assert.equal(out.endDate, '2026-08-10');
    assert.deepEqual(out.completions, ['2026-08-03']);
  });
  test('N5 原地归一化：补齐默认字段且保留旧字段', () => {
    const input = { id: 'n1', title: 'x' };
    const out = normNoteInSandbox(input);
    assert.equal(out.startDate, null, '应补齐 startDate=null');
    assert.equal(out.endDate, null, '应补齐 endDate=null');
    assert.deepEqual(out.completions, [], '应补齐 completions=[]');
    assert.equal(out.title, 'x', '旧字段 title 应保留');
  });
});

/* ══════════════════════════ 2. isInFocusToday ══════════════════════════ */

describe('2. isInFocusToday：时间线覆盖今天且未删除', () => {
  function call(note, today) {
    const env = makeSandbox();
    return env.api.get(`isInFocusToday(${JSON.stringify(note)}, ${JSON.stringify(today)})`);
  }
  test('F1 起止覆盖今天 → true', () => {
    assert.equal(call({ startDate: '2026-08-01', endDate: '2026-08-10' }, '2026-08-08'), true);
  });
  test('F2 今天在起之前 → false', () => {
    assert.equal(call({ startDate: '2026-08-09', endDate: '2026-08-10' }, '2026-08-08'), false);
  });
  test('F3 今天在止之后 → false', () => {
    assert.equal(call({ startDate: '2026-08-01', endDate: '2026-08-07' }, '2026-08-08'), false);
  });
  test('F4 缺起始日期 → false', () => {
    assert.equal(call({ endDate: '2026-08-10' }, '2026-08-08'), false);
  });
  test('F5 缺截止日期 → false', () => {
    assert.equal(call({ startDate: '2026-08-01' }, '2026-08-08'), false);
  });
  test('F6 已删除 → false', () => {
    assert.equal(call({ startDate: '2026-08-01', endDate: '2026-08-10', deleted: true }, '2026-08-08'), false);
  });
  test('F7 边界当天（今天=起=止）→ true', () => {
    assert.equal(call({ startDate: '2026-08-08', endDate: '2026-08-08' }, '2026-08-08'), true);
  });
});

/* ══════════════════════════ 3. toggleCompletion（去重 / 撤销 / 不可变） ══════════════════════════ */

describe('3. toggleCompletion：首次打卡去重、再次同日期撤销、返回新对象不 mutate 原 note', () => {
  function toggle(note, date) {
    const env = makeSandbox();
    return { out: plain(env.api.get(`toggleCompletion(${JSON.stringify(note)}, ${JSON.stringify(date)})`)) };
  }
  test('T1 首次 push 日期', () => {
    const { out } = toggle({ id: 'n1', completions: [] }, '2026-08-08');
    assert.deepEqual(out.completions, ['2026-08-08']);
  });
  test('T2 已含该日期再 toggle → 移除（撤销），不重复添加', () => {
    const { out } = toggle({ id: 'n1', completions: ['2026-08-08'] }, '2026-08-08');
    assert.deepEqual(out.completions, [], '再次同日期应移除（撤销），而非重复添加');
  });
  test('T3 多日期累加不互相干扰', () => {
    const { out } = toggle({ id: 'n1', completions: ['2026-08-08'] }, '2026-08-09');
    assert.deepEqual(out.completions, ['2026-08-08', '2026-08-09']);
  });
  test('T4 返回新对象，不 mutate 原 note', () => {
    const src = { id: 'n1', completions: [] };
    const { out } = toggle(src, '2026-08-08');
    assert.notEqual(out, src, 'toggleCompletion 应返回新对象');
    assert.deepEqual(src.completions, [], '原 note.completions 不应被改写');
  });
  test('T5 撤销后再打卡可重新加回', () => {
    let note = { id: 'n1', completions: [] };
    const env = makeSandbox();
    note = plain(env.api.get(`toggleCompletion(${JSON.stringify(note)}, "2026-08-08")`));
    note = plain(env.api.get(`toggleCompletion(${JSON.stringify(note)}, "2026-08-08")`));
    assert.deepEqual(note.completions, [], '两次同日期应回到空');
    note = plain(env.api.get(`toggleCompletion(${JSON.stringify(note)}, "2026-08-08")`));
    assert.deepEqual(note.completions, ['2026-08-08'], '撤销后再次打卡应重新出现');
  });
});

/* ══════════════════════════ 4. getCompletionMap / getCompletionsByDate（日历点亮数据源） ══════════════════════════ */

describe('4. 完成聚合（日历点亮数据源）', () => {
  const NOTES = [
    { id: 'n1', title: 'A', completions: ['2026-08-08', '2026-08-09'], deleted: false },
    { id: 'n2', title: 'B', completions: ['2026-08-08'], deleted: false },
    { id: 'n3', title: 'C', completions: ['2026-08-10'], deleted: true }, // 软删不计
  ];
  function mapOf(notes) {
    const env = makeSandbox();
    return plain(env.api.get(`getCompletionMap(${JSON.stringify(notes)})`));
  }
  function byDate(notes, date) {
    const env = makeSandbox();
    return plain(env.api.get(`getCompletionsByDate(${JSON.stringify(notes)}, ${JSON.stringify(date)})`));
  }
  test('M1 多 note 多 date 聚合为 {date:[id,...]}', () => {
    const m = mapOf(NOTES);
    assert.deepEqual(m['2026-08-08'].sort(), ['n1', 'n2']);
    assert.deepEqual(m['2026-08-09'], ['n1']);
  });
  test('M2 软删 note 不计入聚合', () => {
    const m = mapOf(NOTES);
    assert.ok(!('2026-08-10' in m), '已删除 note 的完成日期不应点亮日历');
  });
  test('M3 getCompletionsByDate 返回当天完成 Note[]（排除软删）', () => {
    const list = byDate(NOTES, '2026-08-08');
    assert.deepEqual(list.map((n) => n.id).sort(), ['n1', 'n2']);
    assert.ok(!list.some((n) => n.id === 'n3'));
  });
  test('M4 无完成记录的日期返回空数组', () => {
    assert.deepEqual(byDate(NOTES, '2026-01-01'), []);
  });
});

/* ══════════════════════════ 5. daysBetween ══════════════════════════ */

describe('5. daysBetween：b-a 相差天数', () => {
  function db(a, b) {
    const env = makeSandbox();
    return env.api.get(`daysBetween(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
  }
  test('D1 相邻日 = 1', () => { assert.equal(db('2026-08-08', '2026-08-09'), 1); });
  test('D2 跨月正确（1/31 → 2/1）= 1', () => { assert.equal(db('2026-01-31', '2026-02-01'), 1); });
  test('D3 跨年正确（12/31 → 1/1）= 1', () => { assert.equal(db('2025-12-31', '2026-01-01'), 1); });
  test('D4 同一天 = 0', () => { assert.equal(db('2026-08-08', '2026-08-08'), 0); });
  test('D5 倒序为负', () => { assert.equal(db('2026-08-10', '2026-08-08'), -2); });
  test('D6 缺参返回 NaN', () => { assert.ok(Number.isNaN(db('', '2026-08-08'))); });
});

/* ══════════════════════════ 6. 矩阵渲染结构（真实 renderMatrix / matrixRowHtml 真跑） ══════════════════════════ */

describe('6. 矩阵渲染：首行未归类 + 方向行 + 卡片结构', () => {
  const DIRS = [
    { id: 'g1', name: '创业', cat: '创业', ord: 0, deleted: false, archived: false },
    { id: 'g2', name: '医学', cat: '医学', ord: 1, deleted: false, archived: false },
  ];
  const NOTES = [
    { id: 'n_inbox', title: '散装任务', dir: null, deleted: false, status: 'todo' },
    { id: 'n_g1', title: '写 BP', dir: 'g1', deleted: false, status: 'todo', prio: 'high' },
    { id: 'n_g2', title: '看论文', dir: 'g2', deleted: false, status: 'todo', prio: 'mid' },
  ];

  test('R1 renderMatrix 首行是「📥 未归类」虚拟行（matrix-row-inbox），其后才是真实方向行', () => {
    const env = makeSandbox({ directions: DIRS, notes: NOTES });
    env.api.get('renderMatrix()');
    const html = env.matrixWrap.innerHTML;
    assert.ok(html.includes('matrix-row-inbox'), '首行应为未归类虚拟行');
    assert.ok(html.includes('📥') && html.includes('未归类'), '未归类行应包含 📥 未归类 文案');
    assert.ok(html.indexOf('matrix-row-inbox') < html.indexOf('创业'), '未归类行必须在真实方向行之前');
    assert.ok(html.indexOf('matrix-row-inbox') < html.indexOf('医学'), '未归类行必须在真实方向行之前');
  });

  test('R2 矩阵卡片含标题 + 完成勾选 + 日期切换（data-complete / data-date-toggle）', () => {
    const env = makeSandbox({ directions: DIRS, notes: NOTES });
    env.api.get('renderMatrix()');
    const html = env.matrixWrap.innerHTML;
    assert.ok(html.includes('散装任务'), '未归类卡片应含任务标题');
    assert.ok(html.includes('data-complete="n_inbox"'), '卡片应有完成勾选 data-complete');
    assert.ok(html.includes('data-date-toggle="n_inbox"'), '卡片应有日期切换 data-date-toggle');
    assert.ok(html.includes('matrix-card'), '应渲染矩阵卡片');
  });

  test('R3 归档/软删方向不成为行', () => {
    const dirs = [
      { id: 'g1', name: '创业', cat: '创业', deleted: false, archived: false },
      { id: 'g_arch', name: '归档', cat: '个人', archived: true },
      { id: 'g_del', name: '已删', cat: '个人', deleted: true },
    ];
    const env = makeSandbox({ directions: dirs, notes: NOTES });
    env.api.get('renderMatrix()');
    const html = env.matrixWrap.innerHTML;
    assert.ok(!html.includes('归档'), '已归档方向不应成为矩阵行');
    assert.ok(!html.includes('已删'), '已软删方向不应成为矩阵行');
    assert.ok(html.includes('创业'), '活跃方向应成为矩阵行');
  });

  test('R4 matrixRowHtml 单行为虚拟方向时带 matrix-row-inbox 且含 emoji/name/计数', () => {
    const env = makeSandbox();
    const html = env.api.get('matrixRowHtml(GOAL_INBOX, [])');
    assert.ok(html.includes('matrix-row-inbox'), '未归类行应带 matrix-row-inbox');
    assert.ok(html.includes('📥') && html.includes('未归类'));
    assert.ok(html.includes('matrix-count'), '行头应包含计数位');
  });

  test('R5 源码层行映射语义：renderMatrix 先放未归类行再 concat 真实方向行，且过滤 !deleted&&!archived', () => {
    const src = sliceBetween(HTML, 'function renderMatrix(){', 'function bindMatrix(){', 'renderMatrix');
    assert.match(src, /realDirs\s*=\s*directions\.filter\(d=>!d\.deleted && !d\.archived\)/, 'renderMatrix 须过滤已删/已归档方向');
    assert.match(src, /\[matrixRowHtml\(GOAL_INBOX, getDirNotes\(GOAL_INBOX\.id\)\)\]\s*\.concat\(realDirs\.map\(d=>\s*matrixRowHtml\(d, getDirNotes\(d\.id\)\)\)\)/, 'renderMatrix 须先放未归类行再 concat 真实方向行');
  });
});

/* ══════════════════════════ 7. applyToggleCompletion：写回 notes（嵌 completions，非顶层新键） ══════════════════════════ */

describe('7. applyToggleCompletion：完成/撤销写回 notes.completions（零新增顶层同步键）', () => {
  test('A1 打卡后对应 note.completions 含该日期，且触发 saveNotes', () => {
    const env = makeSandbox({ notes: [{ id: 'n1', title: 'x', completions: [] }] });
    env.api.get('applyToggleCompletion("n1", "2026-08-08")');
    const notes = plain(env.api.get('notes'));
    assert.deepEqual(notes[0].completions, ['2026-08-08'], '完成记录应嵌入 note.completions');
    assert.ok(env.calls.saveNotes >= 1, '应触发 saveNotes（持久化）');
  });
  test('A2 再次同日期 → 撤销（从 completions 移除），不新建顶层键', () => {
    const env = makeSandbox({ notes: [{ id: 'n1', title: 'x', completions: ['2026-08-08'] }] });
    env.api.get('applyToggleCompletion("n1", "2026-08-08")');
    const notes = plain(env.api.get('notes'));
    assert.deepEqual(notes[0].completions, [], '再次同日期应撤销完成');
  });
  test('A3 不存在的 id 不崩溃、不写坏 notes', () => {
    const env = makeSandbox({ notes: [{ id: 'n1', title: 'x', completions: [] }] });
    env.api.get('applyToggleCompletion("nope", "2026-08-08")');
    const notes = plain(env.api.get('notes'));
    assert.equal(notes.length, 1, '不应新增/丢失 note');
  });
});

/* ══════════════════════════ 8. 完成日历结构（真实 renderTodoCalendar / renderDayCompletions 真跑） ══════════════════════════ */

describe('8. 完成日历：月视图点亮 + 点日下钻', () => {
  const NOTES = [
    { id: 'n1', title: '写 BP', completions: ['2026-08-08'], deleted: false },
    { id: 'n2', title: '看论文', completions: ['2026-08-08', '2026-08-15'], deleted: false },
  ];

  test('C1 renderTodoCalendar 渲染月视图网格 + 有完成的日期被点亮（has + dot）', () => {
    const env = makeSandbox({ notes: NOTES });
    // 固定视区为 2026-08，使完成日期落在当前月
    env.api.set('calViewYear', 2026);
    env.api.set('calViewMonth', 7);
    env.api.get('renderTodoCalendar()');
    const html = env.todoCal.innerHTML;
    assert.ok(html.includes('cal-grid'), '应渲染月视图网格');
    assert.ok((html.match(/data-cal-day=/g) || []).length >= 28, '应渲染当月日期格子');
    assert.ok(html.includes('data-cal-day="2026-08-08"'), '应渲染 8-08 日期格');
    assert.ok(/class="cal-cell[^"]*has/.test(html), '有完成的日期格应带 has 类（点亮）');
    assert.ok(html.includes('dot'), '点亮格应有 dot 标记');
  });

  test('C2 renderDayCompletions 点日下钻：列出当天完成的 note，可返回', () => {
    const env = makeSandbox({ notes: NOTES });
    env.api.get('renderDayCompletions("2026-08-08")');
    const html = env.calDayView.innerHTML;
    assert.ok(html.includes('2026-08-08'), '下钻视图应含日期标题');
    assert.ok(html.includes('完成 2 项'), '应统计当天完成 2 项');
    assert.ok(html.includes('写 BP') && html.includes('看论文'), '应列出当天完成的任务');
    assert.ok(html.includes('data-cal-back'), '应提供返回按钮');
  });

  test('C3 软删 note 的完成不点亮、不下钻', () => {
    const notes = [
      { id: 'n1', title: 'A', completions: ['2026-08-08'], deleted: false },
      { id: 'n2', title: 'B', completions: ['2026-08-08'], deleted: true },
    ];
    const env = makeSandbox({ notes });
    env.api.set('calViewYear', 2026);
    env.api.set('calViewMonth', 7);
    env.api.get('renderTodoCalendar()');
    env.api.get('renderDayCompletions("2026-08-08")');
    const html = env.calDayView.innerHTML;
    assert.ok(html.includes('完成 1 项'), '软删 note 不应计入当天完成');
    assert.ok(html.includes('A') && !html.includes('B'), '下钻不应列出已删除 note');
  });
});

/* ══════════════════════════ 9. 镜像一致 ══════════════════════════ */

describe('9. 镜像铁律：workbench.html 与 index.html 字节级一致', () => {
  test('X1 两文件逐字节相等', () => {
    assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未与 workbench.html 同步（矩阵重设计须双文件同改）');
  });
});
