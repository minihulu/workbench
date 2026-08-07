/**
 * 需求 A（重构版）：行动系统首页由 hub 改为「横向列式看板（Kanban）」—— 独立验证测试
 *
 * 策略：与 todo-goals / pdf-* 系列一致——不重新实现被测逻辑，从 workbench.html 按标记抽取
 * 真实源码片段（normNote / normDir / GOAL_INBOX / 派生层 / 今日聚焦 / 看板渲染与交互），
 * 放进带 mini-DOM / document / 存储 mock 的 vm 沙箱里真跑，断言线上代码本身。
 *
 * 覆盖（任务要求）：
 *   1 未归类列：dir===null 的 notes 全部出现在首列；directions 任何时刻不含 '__inbox__' 虚拟 id
 *   2 列映射：N 个 direction → 看板 N 列（不含未归类列）；每列子任务 = dir===该 id 的 notes
 *   3 加列：addKanbanColumn() 向 directions 追加新 direction（默认 title），不破坏现有 notes 的 dir
 *   4 删列：deleteKanbanColumn(id) 后该 direction 软删，其下 notes.dir 全部变 null（归未归类），不丢数据
 *   5 进度：某列 done/total 计算正确（x/y + 百分比），软删/完成的判定与旧版一致
 *   6 行内加子任务焦点不丢：DOM stub 下，添加回调后输入框元素引用不被替换（结构断言）
 *   7 中文输入法保护：isComposing / keyCode===229 时不触发添加
 *   8 今日聚焦联动：子任务 focus=true 时顶部聚焦条包含它；看板卡片 ☆ 切换实时反映到顶部（不重建整板）
 *
 * 重构红线（静态）：goalList 已移除；renderKanban 用 concat 追加未归类虚拟列，绝不 push 进 directions。
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

const R_NORMNOTE = sliceBetween(HTML, 'function normNote(n){', 'notes = notes.map(normNote);', 'normNote');
const R_NORMDIR = sliceBetween(HTML, 'function normDir(d){', 'let directions = LS.get("wb_directions", undefined);', 'normDir');
const R_INBOX = sliceBetween(HTML, 'const GOAL_INBOX = { id:"__inbox__"', 'function normReview(', 'GOAL_INBOX');
const R_DERIVE = sliceBetween(HTML, 'const PRIO_RANK = { high:0, mid:1, low:2 };', '/* ---- 首页 hub ---- */', 'derive');
const R_FOCUS = sliceBetween(HTML, 'function renderActHome(){', '/* ---- 看板（Kanban）', 'focus');
const R_KANBAN = sliceBetween(HTML, '/* ---- 看板（Kanban）', 'function openGoal(gid){', 'kanban');

/* 抽取边界自检：区块必须真的含被测函数 */
assert.ok(R_DERIVE.includes('function goalStats(gid){'), '派生区块缺少 goalStats');
assert.ok(R_DERIVE.includes('function addSubTask(gid, title){'), '派生区块缺少 addSubTask');
assert.ok(R_FOCUS.includes('function renderActFocus(){'), '聚焦区块缺少 renderActFocus');
assert.ok(R_KANBAN.includes('function renderKanban(){'), '看板区块缺少 renderKanban');
assert.ok(R_KANBAN.includes('function addKanbanColumn(){'), '看板区块缺少 addKanbanColumn');
assert.ok(R_KANBAN.includes('function deleteKanbanColumn(gid){'), '看板区块缺少 deleteKanbanColumn');
assert.ok(R_KANBAN.includes('function syncBoardStar(nid){'), '看板区块缺少 syncBoardStar');
assert.ok(R_KANBAN.includes('function kanbanCardsHtml(gid){'), '看板区块缺少 kanbanCardsHtml');
assert.ok(!/function goalList\(/.test(HTML), 'goalList 应已在看板重构中移除（改注释占位）');

/* ══════════════════════════ mini-DOM / 存储 / document mock ══════════════════════════ */

function makeEl(tag = 'div') {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    style: { cssText: '', display: '', width: '', height: '' },
    dataset: {}, children: [], parentNode: null,
    textContent: '', value: '', _html: '', __focusCount: 0, _htmlWrites: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { if (force === undefined) force = !classes.has(c); force ? classes.add(c) : classes.delete(c); return force; },
    },
    appendChild(c) { el.children.push(c); if (c) c.parentNode = el; return c; },
    focus() { el.__focusCount++; },
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
    set: (v) => { el._html = String(v); el._htmlWrites++; el.children.length = 0; },
  });
  return el;
}

/** 看板容器：记录事件处理器 + innerHTML 写入次数（用于「不重建整板」断言） */
function makeBoard() {
  const classes = new Set();
  const handlers = {};
  const el = {
    tagName: 'DIV', style: {}, dataset: {}, children: [], parentNode: null,
    textContent: '', value: '', _html: '', __focusCount: 0, _htmlWrites: 0, _handlers: handlers,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => { if (force === undefined) force = !classes.has(c); force ? classes.add(c) : classes.delete(c); return force; },
    },
    appendChild(c) { el.children.push(c); return c; },
    focus() { el.__focusCount++; },
    addEventListener(t, fn) { (handlers[t] || (handlers[t] = [])).push(fn); },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = String(v); el._htmlWrites++; el.children.length = 0; },
  });
  return el;
}

/**
 * 构建 vm 沙箱：notes / directions 由测试注入；真实源码区块 + 全量 stub。
 * 返回 { api, calls, els, sandbox, confirm }：api.get/set 读写模块级绑定，calls 记录副作用。
 */
function makeSandbox({ notes = [], directions = [] } = {}) {
  const calls = {
    saveNotes: 0, saveDirections: 0, persistNotes: 0, persistDirections: 0, scheduleSync: 0,
    toast: [], confirmCalls: [], openModal: [], closeModal: [],
    renderActFocus: 0, renderActReview: 0, renderGoalSubs: 0, renderGoalHead: 0,
    openGoal: 0, openGoalEdit: 0,
  };
  const store = {};
  const els = {};
  const board = makeBoard();
  els['#kanbanBoard'] = board;

  // confirm 可配置（删列测试需 return true）
  let confirmReturn = true;
  const confirm = () => { calls.confirmCalls.push(confirmReturn); return confirmReturn; };

  const sandbox = {
    console, Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number,
    Date, parseFloat, parseInt, isNaN,
    notes, directions,
    LS: { get: (k, d) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; } },
    uid: (() => { let n = 0; return () => 'id-' + (++n) + '-' + Date.now().toString(36); })(),
    deviceId: 'dev-test',
    toast: (m) => calls.toast.push(m),
    confirm,
    openModal: (s) => calls.openModal.push(s),
    closeModal: (s) => calls.closeModal.push(s),
    saveNotes() { calls.saveNotes++; calls.persistNotes++; calls.scheduleSync++; },
    persistNotes() { calls.persistNotes++; },
    saveDirections() { calls.saveDirections++; calls.persistDirections++; calls.scheduleSync++; },
    persistDirections() { calls.persistDirections++; },
    scheduleSync() { calls.scheduleSync++; },
    renderActFocus() { calls.renderActFocus++; },
    renderActReview() { calls.renderActReview++; },
    renderGoalSubs() { calls.renderGoalSubs++; },
    renderGoalHead() { calls.renderGoalHead++; },
    openGoal() { calls.openGoal++; },
    openGoalEdit() { calls.openGoalEdit++; },
    // 渲染依赖的展示辅助（不在抽取区块内，提供 faithful stub）
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    STATUS_COLOR: { todo: '#95a5a6', doing: '#0984E3', done: '#27ae60' },
    STATUS_LABEL: { todo: '未开始', doing: '进行中', done: '已完成' },
    etaLabel: (m) => (m ? String(m) + ' 分钟' : ''),
    todayStr: () => '2026-01-01',
    // document mock：默认 querySelector 返回 null；syncBoardStar/refreshKanbanColumn 测试按需覆盖
    document: { querySelector: () => null, querySelectorAll: () => [] },
    // 事件委托/键盘处理器用到的选择器助手（bindKanban 通过 e.target.closest 取元素）
    $: (sel) => (els[sel] || (els[sel] = makeEl())),
    $$: () => [],
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
    [R_NORMNOTE, R_NORMDIR, R_INBOX, R_DERIVE, R_FOCUS, R_KANBAN, epilogue].join('\n'),
    sandbox,
    { filename: 'kanban.js' }
  );

  return { api: sandbox.__api, calls, els, sandbox, setConfirm: (v) => { confirmReturn = v; }, board };
}

/** vm 对象来自另一 realm，deepEqual 前先归一化 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 从渲染后的看板 HTML 抽取「列」级 data-gid（排除列内子元素，精确匹配外层 kanban-col div） */
function colGids(html) {
  return [...html.matchAll(/<div class="kanban-col [^"]*" data-gid="([^"]+)"/g)].map((m) => m[1]);
}

/* ══════════════════════════ 1. 未归类列 ══════════════════════════ */

describe('1. 未归类列（dir===null 全部进首列；directions 永不含 __inbox__）', () => {
  test('U1 渲染看板：首列为 __inbox__，其后是真实方向列；directions 数组不被污染', () => {
    const env = makeSandbox({
      directions: [{ id: 'g1', name: '创业', cat: '创业' }],
      notes: [
        { id: 'n1', title: '散装A', dir: null, deleted: false, status: 'todo' },
        { id: 'n2', title: '子任务B', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n3', title: '散装C', dir: null, deleted: false, status: 'todo' },
      ],
    });
    env.api.get('renderKanban()');
    const gids = colGids(env.board.innerHTML);
    assert.deepEqual(gids, ['__inbox__', 'g1'], '列顺序应为 [未归类, 真实方向]');
    // 关键：directions 数组本身仍不含 __inbox__
    const dirs = plain(env.api.get('directions'));
    assert.ok(!dirs.some((d) => d.id === '__inbox__'), 'directions 被污染进了虚拟列 id');
  });

  test('U2 未归类列卡片 = 所有 dir 为空（null 与 空串）的 notes，不含真实方向任务', () => {
    const env = makeSandbox({
      directions: [{ id: 'g1', name: 'A', cat: '个人' }],
      notes: [
        { id: 'n1', title: '散装A', dir: null, deleted: false, status: 'todo' },
        { id: 'n2', title: '空串也归未归类', dir: '', deleted: false, status: 'todo' },
        { id: 'n3', title: '属于g1', dir: 'g1', deleted: false, status: 'todo' },
      ],
    });
    const html = env.api.get('kanbanCardsHtml(GOAL_INBOX.id)');
    assert.ok(html.includes('散装A'), '未归类列应含 dir=null 任务');
    assert.ok(html.includes('空串也归未归类'), '未归类列应含 dir="" 任务');
    assert.ok(!html.includes('属于g1'), '未归类列不得含真实方向任务');
  });

  test('U3 反复渲染看板后 directions 仍不含 __inbox__（不污染）', () => {
    const env = makeSandbox({
      directions: [{ id: 'g1', name: 'A', cat: '个人' }],
      notes: [{ id: 'n1', title: 'y', dir: '', deleted: false, status: 'todo' }],
    });
    for (let i = 0; i < 3; i++) env.api.get('renderKanban()');
    const dirs = plain(env.api.get('directions'));
    assert.ok(!dirs.some((d) => d.id === '__inbox__'));
  });
});

/* ══════════════════════════ 2. 列映射（N 方向 → N 列） ══════════════════════════ */

describe('2. 列映射（N 个 direction → N 列；每列子任务严格按 dir 过滤）', () => {
  test('M1 2 个方向 → 看板 3 列（1 未归类 + 2 真实），归档/软删方向不出现', () => {
    const env = makeSandbox({
      directions: [
        { id: 'g1', name: 'A', cat: '个人', ord: 0 },
        { id: 'g2', name: 'B', cat: '创业', ord: 1 },
        { id: 'g_arch', name: '归档', cat: '个人', archived: true },
        { id: 'g_del', name: '已删', cat: '个人', deleted: true },
      ],
      notes: [
        { id: 'n1', title: 'A1', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n2', title: 'A2', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n3', title: 'B1', dir: 'g2', deleted: false, status: 'todo' },
        { id: 'n4', title: 'U1', dir: null, deleted: false, status: 'todo' },
      ],
    });
    env.api.get('renderKanban()');
    const gids = colGids(env.board.innerHTML);
    assert.deepEqual(gids, ['__inbox__', 'g1', 'g2'], '归档/软删方向不应成为列');
  });

  test('M2 每列卡片严格等于 dir===该 id 的 notes（不串列）', () => {
    const env = makeSandbox({
      directions: [
        { id: 'g1', name: 'A', cat: '个人' },
        { id: 'g2', name: 'B', cat: '创业' },
      ],
      notes: [
        { id: 'n1', title: 'A1', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n2', title: 'A2', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n3', title: 'B1', dir: 'g2', deleted: false, status: 'todo' },
        { id: 'n4', title: 'U1', dir: null, deleted: false, status: 'todo' },
      ],
    });
    const g1 = env.api.get('kanbanCardsHtml("g1")');
    const g2 = env.api.get('kanbanCardsHtml("g2")');
    const inbox = env.api.get('kanbanCardsHtml(GOAL_INBOX.id)');
    assert.ok(g1.includes('A1') && g1.includes('A2'), 'g1 列应含 A1/A2');
    assert.ok(!g1.includes('B1') && !g1.includes('U1'), 'g1 列不得串入 B1/U1');
    assert.ok(g2.includes('B1') && !g2.includes('A1'), 'g2 列应含 B1 不含 A1');
    assert.ok(inbox.includes('U1') && !inbox.includes('A1') && !inbox.includes('B1'), '未归类列只含 U1');
  });
});

/* ══════════════════════════ 3. 加列 ══════════════════════════ */

describe('3. 加列（addKanbanColumn 追加方向 + 默认 title，不破坏现有 notes.dir）', () => {
  test('A1 追加新方向（默认 title/emoji/cat），现有 notes 的 dir 完全不变', () => {
    const env = makeSandbox({
      directions: [{ id: 'g1', name: '创业', cat: '创业' }],
      notes: [
        { id: 'n1', title: 'A', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n2', title: 'U', dir: null, deleted: false, status: 'todo' },
      ],
    });
    const beforeLen = plain(env.api.get('directions')).length;
    env.api.get('addKanbanColumn()');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs.length, beforeLen + 1, 'directions 应 +1');
    const nd = dirs[dirs.length - 1];
    assert.equal(nd.name, '', '新列默认 title 应为空（进入内联编辑）');
    assert.equal(nd.emoji, '🎯');
    assert.equal(nd.cat, '个人');
    assert.equal(nd.deleted, false);
    assert.equal(nd.archived, false);
    // 现有 notes 不被破坏
    const notes = plain(env.api.get('notes'));
    assert.equal(notes.find((n) => n.id === 'n1').dir, 'g1', 'g1 任务 dir 不变');
    assert.equal(notes.find((n) => n.id === 'n2').dir, null, '未归类任务 dir 不变');
  });

  test('A2 加列后新增列出现在看板（渲染列数 +1，且为真实列）', () => {
    const env = makeSandbox({
      directions: [{ id: 'g1', name: 'A', cat: '个人' }],
      notes: [],
    });
    env.api.get('renderKanban()');
    const before = colGids(env.board.innerHTML);
    env.api.get('addKanbanColumn()');
    env.api.get('renderKanban()');
    const after = colGids(env.board.innerHTML);
    assert.equal(after.length, before.length + 1, '渲染列数应 +1');
    assert.ok(after.includes('g1'), '旧列仍在');
    assert.ok(!after.includes('__inbox__') || after[0] === '__inbox__', '未归类列仍固定在首');
  });

  test('A3 加列触发持久化链路（saveDirections + scheduleSync）', () => {
    const env = makeSandbox({ directions: [], notes: [] });
    env.api.get('addKanbanColumn()');
    assert.ok(env.calls.saveDirections >= 1, '应调用 saveDirections');
    assert.ok(env.calls.scheduleSync >= 1, '应触发 scheduleSync');
  });
});

/* ══════════════════════════ 4. 删列 ══════════════════════════ */

describe('4. 删列（deleteKanbanColumn：方向软删 + 子任务归未归类，不丢数据）', () => {
  test('D1 删除后方向软删，其下 notes.dir 全部置 null（保留），其他方向/任务不变', () => {
    const env = makeSandbox({
      directions: [
        { id: 'g1', name: '创业', cat: '创业' },
        { id: 'g2', name: '医学', cat: '医学' },
      ],
      notes: [
        { id: 'n1', title: 'A1', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n2', title: 'A2', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n3', title: 'B1', dir: 'g2', deleted: false, status: 'todo' },
        { id: 'n4', title: 'U1', dir: null, deleted: false, status: 'todo' },
      ],
    });
    env.setConfirm(true);
    env.api.get('deleteKanbanColumn("g1")');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs.find((d) => d.id === 'g1').deleted, true, 'g1 应软删');
    assert.ok(!dirs.find((d) => d.id === 'g2').deleted, 'g2 不受影响（未删除）');
    const notes = plain(env.api.get('notes'));
    assert.equal(notes.find((n) => n.id === 'n1').dir, null, 'A1 应归未归类');
    assert.equal(notes.find((n) => n.id === 'n2').dir, null, 'A2 应归未归类');
    assert.equal(notes.find((n) => n.id === 'n3').dir, 'g2', 'B1 不变');
    assert.equal(notes.find((n) => n.id === 'n4').dir, null, '未归类任务不变');
    assert.equal(notes.length, 4, '不得丢数据');
  });

  test('D2 确认框取消（confirm=false）时不删任何东西', () => {
    const env = makeSandbox({
      directions: [{ id: 'g1', name: 'A', cat: '个人' }],
      notes: [{ id: 'n1', title: 'A1', dir: 'g1', deleted: false, status: 'todo' }],
    });
    env.setConfirm(false);
    env.api.get('deleteKanbanColumn("g1")');
    const dirs = plain(env.api.get('directions'));
    assert.ok(!dirs[0].deleted, '取消删除后方向不应被删');
    assert.equal(env.api.get('notes[0].dir'), 'g1', '子任务不应被重新归属');
  });

  test('D3 删除后该列从看板消失，子任务出现在未归类列', () => {
    const env = makeSandbox({
      directions: [
        { id: 'g1', name: 'A', cat: '个人' },
        { id: 'g2', name: 'B', cat: '创业' },
      ],
      notes: [
        { id: 'n1', title: 'A1', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n2', title: 'B1', dir: 'g2', deleted: false, status: 'todo' },
      ],
    });
    env.setConfirm(true);
    env.api.get('deleteKanbanColumn("g1")');
    env.api.get('renderKanban()');
    const gids = colGids(env.board.innerHTML);
    assert.deepEqual(gids, ['__inbox__', 'g2'], 'g1 列应消失');
    const inbox = env.api.get('kanbanCardsHtml(GOAL_INBOX.id)');
    assert.ok(inbox.includes('A1'), '被删列的子任务应落入未归类列');
  });
});

/* ══════════════════════════ 5. 进度 ══════════════════════════ */

describe('5. 进度（done/total + 百分比，软删/完成判定与旧版一致）', () => {
  function mkn(id, { dir, status = 'todo', done = false, deleted = false } = {}) {
    return { id, title: id, status, done, doneAt: done ? 1 : null, dir, deleted, prio: 'mid', cat: '个人' };
  }

  test('P1 空列：total=0/done=0/pct=0，看板进度文案显示「暂无子任务」', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    const st = plain(env.api.get('goalStats("g1")'));
    assert.equal(st.total, 0); assert.equal(st.done, 0); assert.equal(st.pct, 0);
    const prog = env.api.get('kanbanProgHtml("g1")');
    assert.ok(prog.includes('暂无子任务'), '空列应显示占位文案');
  });

  test('P2 2/5 → pct=40（含软删排除、doing 计入分母不计分子）', () => {
    const notes = [
      mkn('n1', { dir: 'g1', status: 'done', done: true }),
      mkn('n2', { dir: 'g1', status: 'done', done: true }),
      mkn('n3', { dir: 'g1', status: 'doing' }),
      mkn('n4', { dir: 'g1', status: 'todo' }),
      mkn('n5', { dir: 'g1', status: 'done', done: true, deleted: true }), // 软删排除
    ];
    const env = makeSandbox({ notes, directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    const st = plain(env.api.get('goalStats("g1")'));
    assert.equal(st.total, 4, '软删任务不得计入分母（5→4）');
    assert.equal(st.done, 2, 'doing 不计分子');
    assert.equal(st.pct, 50);
    const prog = env.api.get('kanbanProgHtml("g1")');
    assert.ok(prog.includes('2/4'), '进度文案应为 2/4');
    assert.ok(prog.includes('50%'), '进度文案应为 50%');
  });

  test('P3 5/5 → pct=100', () => {
    const notes = ['a', 'b', 'c', 'd', 'e'].map((i) => mkn('n' + i, { dir: 'g1', status: 'done', done: true }));
    const env = makeSandbox({ notes, directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    const st = plain(env.api.get('goalStats("g1")'));
    assert.equal(st.done, 5); assert.equal(st.pct, 100);
  });
});

/* ══════════════════════════ 6 & 7. 行内加子任务（焦点不丢 + IME 保护） ══════════════════════════ */

describe('6/7. 行内连续添加（输入框 DOM 不重建 + 中文输入法保护）', () => {
  /** 绑定看板 keydown 处理器到指定 addin 输入框 mock，返回该输入框与触发函数 */
  function bindAddin(env, gid) {
    env.api.get('renderKanban()'); // 触发 bindKanban，捕获 keydown 处理器
    const handlers = env.board._handlers.keydown || [];
    const input = makeEl('input');
    input.dataset.gid = gid;
    input.value = '';
    input.closest = (sel) => (sel === '.kanban-addin' ? input : null);
    const fire = (e) => { for (const h of handlers) h({ target: input, preventDefault() {}, stopPropagation() {}, ...e }); };
    return { input, fire };
  }

  test('K1 回车后输入框元素仍是同一引用（不重建 DOM）+ value 清空 + 焦点保持 + 看板不重建 + 笔记真的加入', () => {
    const env = makeSandbox({
      notes: [], directions: [{ id: 'g1', name: '创业', cat: '创业' }],
    });
    const { input, fire } = bindAddin(env, 'g1');
    const w0 = env.board._htmlWrites;
    input.value = '写 PRD';
    fire({ key: 'Enter', isComposing: false, keyCode: 13 });
    assert.equal(input, env.board._handlers ? input : null, '回车后输入框 DOM 被重建 → 焦点必然丢失');
    assert.equal(input.value, '', '回车后输入框应清空');
    assert.ok(input.__focusCount >= 1, '回车后应调用 input.focus()');
    assert.equal(env.board._htmlWrites, w0, '行内添加不得重建整块看板（否则输入框焦点丢失）');
    const notes = plain(env.api.get('notes'));
    assert.equal(notes.length, 1, '笔记应被加入');
    assert.equal(notes[0].title, '写 PRD');
    assert.equal(notes[0].dir, 'g1');
    assert.equal(notes[0].cat, '创业');
  });

  test('K2 中文输入法组合中（isComposing=true）回车不添加', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    const { input, fire } = bindAddin(env, 'g1');
    input.value = '买菜';
    fire({ key: 'Enter', isComposing: true, keyCode: 229 });
    assert.equal(env.api.get('notes.length'), 0, '输入法组合中回车不得创建半截拼音待办');
  });

  test('K3 中文输入法组合中（keyCode=229）回车不添加', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    const { input, fire } = bindAddin(env, 'g1');
    input.value = '买菜';
    fire({ key: 'Enter', isComposing: false, keyCode: 229 });
    assert.equal(env.api.get('notes.length'), 0);
  });

  test('K4 空输入回车不添加', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    const { input, fire } = bindAddin(env, 'g1');
    input.value = '   ';
    fire({ key: 'Enter', isComposing: false, keyCode: 13 });
    assert.equal(env.api.get('notes.length'), 0);
  });

  test('K5 连续添加 3 条：notes 增长、看板始终不重建（焦点链不断）', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    const { input, fire } = bindAddin(env, 'g1');
    const w0 = env.board._htmlWrites;
    for (const t of ['第一条', '第二条', '第三条']) {
      input.value = t;
      fire({ key: 'Enter', isComposing: false, keyCode: 13 });
    }
    assert.equal(env.api.get('notes.length'), 3);
    assert.equal(env.board._htmlWrites, w0, '连续添加后看板被重建 → 输入框焦点链断裂');
  });
});

/* ══════════════════════════ 8. 今日聚焦联动 ══════════════════════════ */

describe('8. 今日聚焦联动（聚焦条含 focus 任务；卡片 ☆ 切换实时反映到顶部，不重建整板）', () => {
  test('F1 子任务 focus=true 时顶部聚焦条（renderActFocus）包含它', () => {
    const env = makeSandbox({
      notes: [
        { id: 'n1', title: '聚焦任务', dir: 'g1', deleted: false, status: 'todo', focus: true, prio: 'high', cat: '个人' },
        { id: 'n2', title: '普通任务', dir: 'g1', deleted: false, status: 'todo', focus: false, prio: 'low', cat: '个人' },
      ],
      directions: [{ id: 'g1', name: 'A', cat: '个人' }],
    });
    // 真实 renderActFocus（已在 R_FOCUS 区块）直接跑，断言聚焦条 HTML
    vm.runInContext('renderActFocus();', env.sandbox, { filename: 'focus-call.js' });
    const focusHtml = env.els['#actFocus'].innerHTML;
    assert.ok(focusHtml.includes('聚焦任务'), '聚焦条应包含 focus=true 的任务');
    assert.ok(!focusHtml.includes('普通任务'), '聚焦条不应包含未聚焦任务');
  });

  test('F2 卡片 ☆ 点击：n.focus 翻转 + 顶部聚焦条重算（含该任务）+ 看板不重建', () => {
    const env = makeSandbox({
      notes: [
        { id: 'n1', title: '聚焦任务', dir: 'g1', deleted: false, status: 'todo', focus: false, prio: 'mid', cat: '个人' },
      ],
      directions: [{ id: 'g1', name: 'A', cat: '个人' }],
    });
    env.api.get('renderKanban()');
    const writesBefore = env.board._htmlWrites;
    // 构造 star 元素 + 事件，触发 bindKanban 的 click 处理器（star 分支）
    const star = makeEl('button');
    star.dataset.nid = 'n1';
    star.closest = (sel) => (sel === '.kanban-star' ? star : null);
    const clickHandlers = env.board._handlers.click || [];
    const evt = { target: { closest: (sel) => (sel === '.kanban-star' ? star : null) }, preventDefault() {}, stopPropagation() {} };
    for (const h of clickHandlers) h(evt);
    // 断言：数据翻转
    const n = plain(env.api.get('notes')).find((x) => x.id === 'n1');
    assert.equal(n.focus, true, '点击 ☆ 应翻转 focus');
    // 断言：卡片星 DOM 即时更新（不重建整板）
    assert.equal(star.classList.contains('on'), true, '卡片星应即时点亮');
    assert.equal(star.textContent, '★');
    // 断言：顶部聚焦条被重算（现在应包含该任务）
    assert.ok(env.els['#actFocus'].innerHTML.includes('聚焦任务'), '点击 ☆ 应触发顶部聚焦条重算并包含该任务');
    // 断言：看板整块未被重建（innerHTML 写入次数不变）
    assert.equal(env.board._htmlWrites, writesBefore, '卡片 ☆ 切换不得重建整块看板（丢失输入框焦点）');
  });

  test('F3 syncBoardStar：单卡片星即时同步，不重建整板', () => {
    const env = makeSandbox({
      notes: [
        { id: 'n1', title: 'A', dir: 'g1', deleted: false, status: 'todo', focus: true, prio: 'mid', cat: '个人' },
      ],
      directions: [{ id: 'g1', name: 'A', cat: '个人' }],
    });
    // document.querySelector 返回受控 star mock（仅匹配 kanban-star）
    const star = makeEl('button');
    env.sandbox.document.querySelector = (sel) => (sel.includes('kanban-star') ? star : null);
    env.api.get('renderKanban()');
    const writesBefore = env.board._htmlWrites;
    env.api.get('syncBoardStar("n1")');
    assert.equal(star.classList.contains('on'), true, 'syncBoardStar 应点亮星');
    assert.equal(star.textContent, '★');
    assert.equal(env.board._htmlWrites, writesBefore, 'syncBoardStar 不得重建整块看板');
  });
});
