/**
 * 需求 A：待办重做为「大目标 → 子待办」—— 独立验证测试
 *
 * 策略（与 pdf-* 系列一致）：不重新实现被测逻辑，从 workbench.html 按标记抽取
 * 真实源码片段，放进带 mini-DOM / 存储 mock 的 vm 沙箱里真跑，断言线上代码本身。
 *
 * 覆盖：
 *   A 静态不变量（GOAL_INBOX 常量 / 三闸门 / 三屏 CSS 作用域 / 旧标识清零 / 同步键零新增 / 双文件一致）
 *   B normDir 幂等 + 老数据字段补齐（targetDate/ord/archived）
 *   C goalList 派生（含虚拟 __inbox__ 追加语义；directions 任何时刻不含该 id）
 *   D goalStats 进度口径（0/0、2/5、5/5、软删排除、dir 空串与 null 都归未归类）
 *   E goalNextStep 排序（优先级 > 截止日，已完成排除）
 *   F addSubTask（虚拟目标 → dir=null；真实目标 → dir=gid + cat 继承；默认值）
 *   G toggleSubDone（todo⇄done 四字段同步 + 渲染刷新）
 *   H 三闸门（openGoalEdit/saveGoal/deleteGoal 对虚拟目标直接 return）
 *   I A-02 行内连续添加：输入框元素引用不丢（不重建 DOM）+ 中文输入法保护
 *   J deleteGoal 真删：方向软删 + 子待办保留进未归类
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// QA_TARGET_HTML 用于变异测试
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

/** normDir 升级（只取函数本体一行，不触发 LS 初始化） */
const R_NORMDIR = sliceBetween(
  HTML, 'function normDir(d){', 'let directions = LS.get("wb_directions", undefined);', 'normDir');
/** 虚拟「📥 未归类」常量 */
const R_INBOX = sliceBetween(
  HTML, 'const GOAL_INBOX = { id:"__inbox__"', 'function normReview(', 'GOAL_INBOX');
/** normNote（addSubTask 依赖的真实归一化） */
const R_NORMNOTE = sliceBetween(
  HTML, 'function normNote(n){', 'notes = notes.map(normNote);', 'normNote');
/** 派生层 + 写操作：PRIO_RANK → fillTaskListFilters（含 goalList/goalStats/goalNextStep/addSubTask/toggleSubDone/setNoteScreen） */
const R_DERIVE = sliceBetween(
  HTML, 'const PRIO_RANK = { high:0, mid:1, low:2 };', '/* ---- 首页 hub ---- */', 'derive');
/** 目标 CRUD：editingGoalId / openGoalEdit / saveGoal / deleteGoal */
const R_CRUD = sliceBetween(
  HTML, 'let editingGoalId=null;', 'function openReview(date){', 'goalCRUD');
/** 行内连续添加的 keydown 处理器（A-02 成败点） */
const R_KEYDOWN = sliceBetween(
  HTML, '$("#goalAddInput").addEventListener("keydown", e=>{', '$("#reviewSave").onclick=saveReview;', 'keydown');

// 抽取边界自检：区块必须真的含被测函数
assert.ok(R_NORMDIR.includes('targetDate'), 'normDir 区块缺少 targetDate 字段（抽取边界漂移？）');
assert.ok(R_INBOX.includes('__inbox__'), 'GOAL_INBOX 区块抽取异常');
// 看板重构：goalList 已移除（改注释占位），列枚举改由 renderKanban 直接遍历 directions + GOAL_INBOX 虚拟列。
// 数据层口径（goalStats/addSubTask/deleteGoal 等）完全保留，下面断言新实现与重构红线。
assert.ok(!/function goalList\(/.test(HTML), 'goalList 应已在看板重构中移除（改注释占位）');
assert.ok(R_DERIVE.includes('function goalStats(gid){'), '派生区块缺少 goalStats（数据层进度口径被移除？）');
// 矩阵式重设计：看板已退役，未归类仍是虚拟方向（GOAL_INBOX），由 renderMatrix 首行呈现。
assert.ok(!/function renderKanban\(/.test(HTML), '旧看板 renderKanban 应已彻底移除（被矩阵取代）');
assert.ok(!/kanbanColumnHtml/.test(HTML), '旧看板 kanbanColumnHtml 应已彻底移除');
assert.ok(HTML.includes('function renderMatrix()'), '矩阵 renderMatrix 应已落地');
assert.ok(HTML.includes('function matrixRowHtml'), 'matrixRowHtml 应存在');
assert.ok(HTML.includes('function getCompletionMap'), '完成聚合 getCompletionMap 应存在（完成记录嵌 notes）');
assert.ok(HTML.includes('📥 未归类'), '未归类文案仍在（口径等价于旧未归类列）');
assert.ok(R_DERIVE.includes('function addSubTask(gid, title){'), '派生区块缺少 addSubTask');
assert.ok(R_CRUD.includes('function saveGoal(){'), 'CRUD 区块缺少 saveGoal');
assert.ok(R_KEYDOWN.includes('isComposing'), 'keydown 区块缺少中文输入法保护');

/* ══════════════════════════ mini-DOM / 存储 mock ══════════════════════════ */

function makeEl(tag = 'div') {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    style: { cssText: '', display: '', width: '', height: '' },
    dataset: {},
    children: [],
    parentNode: null,
    textContent: '',
    value: '',
    _html: '',
    __focusCount: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        if (force === undefined) force = !classes.has(c);
        force ? classes.add(c) : classes.delete(c);
        return force;
      },
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
    set: (v) => { el._html = String(v); el.children.length = 0; },
  });
  return el;
}

/**
 * 构建 vm 沙箱：notes / directions 由测试注入；真实源码区块 + 全量 stub。
 * 返回 { api, calls, els }：api.get/set 读写模块级 let 绑定，calls 记录各类副作用。
 */
function makeSandbox({ notes = [], directions = [] } = {}) {
  const calls = {
    saveNotes: 0, saveDirections: 0, persistNotes: 0, persistDirections: 0, scheduleSync: 0,
    toast: [], confirmCalls: [], openModal: [], closeModal: [],
    renderActGoals: 0, renderActHome: 0, renderGoalSubs: 0, renderGoalHead: 0,
  };
  const store = {};
  const els = {};

  const sandbox = {
    console, Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number,
    Date, parseFloat, parseInt, isNaN,
    notes, directions,
    LS: {
      get: (k, d) => (k in store ? store[k] : d),
      set: (k, v) => { store[k] = v; },
    },
    uid: (() => { let n = 0; return () => 'id-' + (++n) + '-' + Date.now().toString(36); })(),
    deviceId: 'dev-test',
    toast: (m) => calls.toast.push(m),
    confirm: () => true,
    openModal: (s) => calls.openModal.push(s),
    closeModal: (s) => calls.closeModal.push(s),
    saveNotes() { calls.saveNotes++; calls.persistNotes++; calls.scheduleSync++; },
    persistNotes() { calls.persistNotes++; },
    saveDirections() { calls.saveDirections++; calls.persistDirections++; calls.scheduleSync++; },
    persistDirections() { calls.persistDirections++; },
    scheduleSync() { calls.scheduleSync++; },
    renderActGoals() { calls.renderActGoals++; },
    renderActHome() { calls.renderActHome++; },
    renderGoalSubs() { calls.renderGoalSubs++; },
    renderGoalHead() { calls.renderGoalHead++; },
    esc: (s) => String(s),
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
    [R_NORMNOTE, R_NORMDIR, R_INBOX, R_DERIVE, R_CRUD, epilogue].join('\n'),
    sandbox,
    { filename: 'todo-goals.js' }
  );

  return { api: sandbox.__api, calls, els, sandbox };
}

/** vm 对象来自另一 realm，deepEqual 前先归一化 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** 绑定真实 keydown 处理器到输入框 mock，返回可调用的 handler */
function bindKeydown(env) {
  let handler = null;
  if (!env.els['#goalAddInput']) env.els['#goalAddInput'] = makeEl();
  env.els['#goalAddInput'].addEventListener = (t, fn) => { if (t === 'keydown') handler = fn; };
  vm.runInContext(R_KEYDOWN, env.sandbox, { filename: 'keydown.js' });
  assert.ok(handler, 'keydown 处理器未绑定成功');
  return handler;
}

/* ══════════════════════════ A. 静态不变量 ══════════════════════════ */

describe('A. 静态不变量（虚拟目标 / 三闸门 / CSS 作用域 / 旧标识清零）', () => {
  test('A1 GOAL_INBOX 常量契约：id=__inbox__、virtual=true', () => {
    const ctx = { Set };
    vm.createContext(ctx);
    vm.runInContext(R_INBOX + '\nglobalThis.__g = GOAL_INBOX;', ctx);
    assert.equal(ctx.__g.id, '__inbox__');
    assert.equal(ctx.__g.virtual, true);
    assert.equal(ctx.__g.emoji, '📥');
  });

  test('A2 __inbox__ 字面量在文件中唯一（只出现在 GOAL_INBOX 定义）→ 没有任何代码把该 id 写进 directions', () => {
    const hits = HTML.match(/__inbox__/g) || [];
    assert.equal(hits.length, 1, `__inbox__ 字面量应只出现 1 次（GOAL_INBOX 定义处），实际 ${hits.length} 次`);
  });

  test('A3 矩阵以 concat 追加未归类虚拟行（不 push 进 directions，口径等价于旧看板未归类列）', () => {
    const src = sliceBetween(HTML, 'function renderMatrix(){', 'function bindMatrix(){', 'renderMatrix');
    assert.match(src, /realDirs\s*=\s*directions\.filter\(d=>!d\.deleted && !d\.archived\)/, 'renderMatrix 须过滤已删/已归档方向');
    assert.match(src, /\[matrixRowHtml\(GOAL_INBOX, getDirNotes\(GOAL_INBOX\.id\)\)\]\s*\.concat\(realDirs\.map\(d=>\s*matrixRowHtml\(d, getDirNotes\(d\.id\)\)\)\)/, 'renderMatrix 须先放未归类行再 concat 真实方向行');
    assert.ok(!/directions\.push\(GOAL_INBOX\)/.test(src), 'renderMatrix 内不得出现 directions.push(GOAL_INBOX)');
  });

  test('A4 三闸门：openGoalEdit / saveGoal / deleteGoal 都带 isVirtualGoal 守卫', () => {
    assert.match(R_CRUD, /function openGoalEdit\(id\)\{[\s\S]*?if\(isVirtualGoal\(id\)\)\{/, 'openGoalEdit 首行缺少虚拟目标闸门');
    assert.match(R_CRUD, /function saveGoal\(\)\{[\s\S]*?if\(isVirtualGoal\(editingGoalId\)\)\{/, 'saveGoal 缺少虚拟目标闸门');
    assert.match(R_CRUD, /function deleteGoal\(\)\{[\s\S]*?if\(isVirtualGoal\(editingGoalId\)\)\{/, 'deleteGoal 缺少虚拟目标闸门');
  });

  test('A5 addSubTask 对虚拟目标映射 dir=null（不是字符串 __inbox__）', () => {
    const src = sliceBetween(HTML, 'function addSubTask(gid, title){', 'function toggleSubDone(id){', 'addSubTask');
    assert.match(src, /isVirtualGoal\(gid\) \? null : \(gid \|\| null\)/, 'addSubTask 必须把虚拟目标映射为 null');
  });

  test('A6 三屏 CSS 为 #noteStack 作用域，全局 .dj-track 与日记 #djStack 规则未被动', () => {
    // 全局两屏规则仍在（#djStack 日记共用）
    assert.match(HTML, /\.dj-track\{display:flex; width:200%;/, '全局 .dj-track 两屏规则被改 → 日记会坏');
    assert.match(HTML, /\.dj-stack\.show-edit \.dj-track\{transform:translateX\(-50%\);\}/, '全局两屏转场规则被改');
    // 行动系统三屏作用域规则
    assert.match(HTML, /#noteStack \.dj-track\{ width:300%; \}/, '缺少 #noteStack 三屏宽度规则');
    assert.match(HTML, /#noteStack \.dj-screen\{ width:33\.3333%; flex:0 0 33\.3333%; \}/, '缺少 #noteStack 屏宽规则');
    assert.match(HTML, /#noteStack\.show-goal \.dj-track\{ transform:translateX\(-33\.3333%\); \}/, '缺少 show-goal 转场规则');
    assert.match(HTML, /#noteStack\.show-edit \.dj-track\{ transform:translateX\(-66\.6667%\); \}/, '缺少 show-edit 转场规则');
    assert.match(HTML, /#noteStack\.show-goal \.fab\{ display:none; \}/, '缺少屏1 隐藏 FAB 规则');
    // 日记双屏 DOM 仍存在
    assert.match(HTML, /id="djStack"/, '#djStack（日记）DOM 被删？');
  });

  test('A7 旧标识全部清零：openDir/saveDir(/deleteDir/editingDirId/actNewDir/actDirs/dirTasks', () => {
    for (const ident of ['openDir', 'deleteDir', 'editingDirId', 'actNewDir', 'actDirs', 'dirTasks']) {
      assert.equal((HTML.match(new RegExp(ident, 'g')) || []).length, 0, `旧标识 ${ident} 仍有残留`);
    }
    // saveDir 只能以 saveDirections 形式存在（函数调用 saveDir( 必须为 0）
    assert.equal((HTML.match(/saveDir\s*\(/g) || []).length, 0, '旧 saveDir( 调用残留');
  });

  test('A8 同步 payload 顶层键零新增（无 goals/cogGoals 新键）', () => {
    const line = HTML.split('\n').find((l) => l.includes('const payload = {'));
    assert.ok(line, '找不到同步 payload 组装行');
    const m = line.match(/const payload = \{([^}]*)\}/);
    assert.ok(m, 'payload 组装行解析失败');
    const keys = m[1].split(',').map((s) => s.split(':')[0].trim()).filter(Boolean);
    const allowed = new Set(['times', 'ideas', 'notes', 'diary', 'cog_reads', 'cog_books',
      'cog_thoughts', 'cog_reviews', 'cog_expr', 'cog_annos', 'directions', 'reviews', 'settings']);
    for (const k of keys) {
      assert.ok(allowed.has(k), `同步 payload 出现未授权顶层键: ${k}`);
    }
  });

  test('A9 复盘「推进了 M 个目标」口径：仅统计今天完成且有真实 dir 的任务', () => {
    const src = sliceBetween(HTML, 'function renderActReview(){', '/* ---- 任务编辑 ---- */', 'renderActReview');
    assert.match(src, /\.map\(n=>n\.dir\)\s*\)\.size/, '缺少按 dir 去重计数的实现');
    assert.match(src, /n\.dir/, '计数逻辑缺少 dir 非空过滤');
    assert.match(src, /推进了目标|推进了 M 个目标/, 'UI 文案未包含「推进了目标」');
  });

  test('A10 index.html 与 workbench.html 字节级一致（镜像铁律）', () => {
    assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未与 workbench.html 同步');
  });
});

/* ══════════════════════════ B. normDir 幂等 ══════════════════════════ */

describe('B. normDir：老数据字段补齐且幂等', () => {
  test('B1 缺字段的老 direction 补齐 targetDate=null / ord=0 / archived=false，原值不变', () => {
    const env = makeSandbox();
    const legacy = { id: 'd1', emoji: '🩺', name: '医学成长', cat: '医学' };
    const out = plain(env.api.get(`normDir(${JSON.stringify(legacy)})`));
    assert.equal(out.targetDate, null);
    assert.equal(out.ord, 0);
    assert.equal(out.archived, false);
    assert.equal(out.name, '医学成长');
    assert.equal(out.cat, '医学');
    assert.equal(out.deleted, false);
  });

  test('B2 已有值不被覆盖：targetDate/ord/archived 原样保留', () => {
    const env = makeSandbox();
    const d = { id: 'd1', name: 'x', targetDate: '2026-12-31', ord: 7, archived: true, cat: '创业' };
    const out = plain(env.api.get(`normDir(${JSON.stringify(d)})`));
    assert.equal(out.targetDate, '2026-12-31');
    assert.equal(out.ord, 7);
    assert.equal(out.archived, true);
  });

  test('B3 幂等：normDir(normDir(d)) 与 normDir(d) 完全一致', () => {
    const env = makeSandbox();
    const d = { id: 'd1', name: 'x' };
    const once = plain(env.api.get(`normDir(${JSON.stringify(d)})`));
    const twice = plain(env.api.get(`normDir(normDir(${JSON.stringify(d)}))`));
    assert.deepEqual(twice, once);
  });
});

/* ══════════════════════════ C. goalList 派生 ══════════════════════════ */

describe('C. 未归类聚合 + 列映射（看板数据层等价断言）', () => {
  function envWith({ dirs, notes }) {
    return makeSandbox({ directions: dirs, notes });
  }

  test('C1 未归类聚合（等价于旧 goalList 未归类列）：goalStats("__inbox__") 统计 dir=null 与 dir=\'\' 任务，排除真实 dir', () => {
    const env = envWith({
      dirs: [{ id: 'g1', name: 'A', cat: '个人' }],
      notes: [
        { id: 'n1', title: 'x', dir: null, deleted: false, status: 'todo' },
        { id: 'n2', title: 'y', dir: '', deleted: false, status: 'todo' },
        { id: 'n3', title: 'z', dir: 'g1', deleted: false, status: 'todo' },
      ],
    });
    const inbox = plain(env.api.get('goalStats("__inbox__")'));
    assert.equal(inbox.total, 2, '未归类应只统计 dir 为空（null/空串）的任务，不含真实目标');
    assert.equal(inbox.done, 0);
    const g1 = plain(env.api.get('goalStats("g1")'));
    assert.equal(g1.total, 1, '真实目标只统计归属自己的子任务');
  });

  test('C2 矩阵行映射语义：renderMatrix 用 realDirs(过滤 !deleted&&!archived) + 未归类虚拟行 枚举，N 活跃方向 → N+1 行', () => {
    const src = sliceBetween(HTML, 'function renderMatrix(){', 'function bindMatrix(){', 'renderMatrix');
    assert.match(src, /realDirs\s*=\s*directions\.filter\(d=>!d\.deleted && !d\.archived\)/, 'renderMatrix 须过滤已删/已归档方向');
    assert.match(src, /\[matrixRowHtml\(GOAL_INBOX, getDirNotes\(GOAL_INBOX\.id\)\)\]\s*\.concat\(realDirs\.map\(d=>\s*matrixRowHtml\(d, getDirNotes\(d\.id\)\)\)\)/, 'renderMatrix 须先放未归类行再 concat 真实方向行');
  });

  test('C3 directions 永不写入 __inbox__（虚拟列只存在于渲染层，绝不写数组）', () => {
    // 文件中 __inbox__ 字面量仅出现 1 次（GOAL_INBOX 定义），无任何代码把它当真实 id 写进 directions
    assert.equal((HTML.match(/__inbox__/g) || []).length, 1, '__inbox__ 字面量应只在 GOAL_INBOX 定义处出现 1 次');
    assert.ok(!/directions\.push\(GOAL_INBOX/.test(HTML), '不得 directions.push(GOAL_INBOX)');
    assert.ok(!/directions\.map\([^)]*GOAL_INBOX/.test(HTML), '不得把 GOAL_INBOX 映射进 directions');
  });
});

/* ══════════════════════════ D. goalStats 进度口径 ══════════════════════════ */

describe('D. goalStats：x/y + pct 口径', () => {
  function mk(n) {
    return {
      id: 'n' + n, title: 't' + n, status: 'todo', done: false, doneAt: null,
      dir: null, deleted: false, prio: 'mid', dueDate: null, cat: '个人',
    };
  }

  test('D1 空目标：total=0 / done=0 / pct=0 / nextStep=null', () => {
    const env = makeSandbox({ notes: [] });
    const st = plain(env.api.get('goalStats("g1")'));
    assert.equal(st.total, 0);
    assert.equal(st.done, 0);
    assert.equal(st.pct, 0);
    assert.equal(st.nextStep, null);
  });

  test('D2 2/5 → pct=40', () => {
    const notes = [mk(1), mk(2), mk(3), mk(4), mk(5)].map((x, i) => {
      x.dir = 'g1';
      if (i < 2) { x.status = 'done'; x.done = true; }
      return x;
    });
    const env = makeSandbox({ notes });
    const st = plain(env.api.get('goalStats("g1")'));
    assert.equal(st.total, 5);
    assert.equal(st.done, 2);
    assert.equal(st.pct, 40);
  });

  test('D3 5/5 → pct=100', () => {
    const notes = [1, 2, 3, 4, 5].map((i) => {
      const x = mk(i); x.dir = 'g1'; x.status = 'done'; x.done = true; return x;
    });
    const env = makeSandbox({ notes });
    const st = plain(env.api.get('goalStats("g1")'));
    assert.equal(st.done, 5);
    assert.equal(st.pct, 100);
  });

  test('D4 软删任务不计入分母；doing 计入分母不计分子', () => {
    const n1 = mk(1); n1.dir = 'g1'; n1.status = 'doing';
    const n2 = mk(2); n2.dir = 'g1'; n2.deleted = true; n2.status = 'done';
    const n3 = mk(3); n3.dir = 'g1'; n3.status = 'done';
    const env = makeSandbox({ notes: [n1, n2, n3] });
    const st = plain(env.api.get('goalStats("g1")'));
    assert.equal(st.total, 2, '软删任务不得计入分母');
    assert.equal(st.done, 1, 'doing 不计分子');
    assert.equal(st.pct, 50);
  });

  test('D5 __inbox__ 统计 dir 为空（null 与 空串 都归入）', () => {
    const n1 = mk(1); n1.dir = null; n1.status = 'done';
    const n2 = mk(2); n2.dir = ''; n2.status = 'todo';
    const n3 = mk(3); n3.dir = 'g1'; n3.status = 'done'; // 归属真实目标，不算
    const env = makeSandbox({ notes: [n1, n2, n3] });
    const st = plain(env.api.get('goalStats("__inbox__")'));
    assert.equal(st.total, 2);
    assert.equal(st.done, 1);
    assert.equal(st.pct, 50);
  });

  test('D6 goalStats 是纯派生：调用不改 notes / directions', () => {
    const notes = [mk(1)]; notes[0].dir = 'g1';
    const dirs = [{ id: 'g1', name: 'A', cat: '个人' }];
    const env = makeSandbox({ notes, directions: dirs });
    const beforeNotes = JSON.stringify(plain(env.api.get('notes')));
    const beforeDirs = JSON.stringify(plain(env.api.get('directions')));
    env.api.get('goalStats("g1")'); env.api.get('goalStats("__inbox__")');
    assert.equal(JSON.stringify(plain(env.api.get('notes'))), beforeNotes);
    assert.equal(JSON.stringify(plain(env.api.get('directions'))), beforeDirs);
  });
});

/* ══════════════════════════ E. goalNextStep ══════════════════════════ */

describe('E. goalNextStep：未完成中优先级最高、其次截止日最近', () => {
  function mk(id, { prio = 'mid', dueDate = null, status = 'todo' } = {}) {
    return { id, title: id, status, prio, dueDate, deleted: false };
  }

  test('E1 空输入 → null', () => {
    const env = makeSandbox();
    assert.equal(env.api.get('goalNextStep([])'), null);
  });

  test('E2 已完成全部排除', () => {
    const env = makeSandbox();
    const subs = [mk('a', { status: 'done' }), mk('b', { status: 'done' })];
    assert.equal(env.api.get(`goalNextStep(${JSON.stringify(subs)})`), null);
  });

  test('E3 优先级优先于截止日：low-prio 早截止不敌 mid-prio 晚截止', () => {
    const env = makeSandbox();
    const subs = [
      mk('low-early', { prio: 'low', dueDate: '2026-01-01' }),
      mk('mid-late', { prio: 'mid', dueDate: '2026-12-31' }),
      mk('high', { prio: 'high', dueDate: null }),
    ];
    const next = env.api.get(`goalNextStep(${JSON.stringify(subs)})`);
    assert.equal(next.id, 'high');
  });

  test('E4 同级优先级按截止日最近', () => {
    const env = makeSandbox();
    const subs = [
      mk('far', { prio: 'mid', dueDate: '2026-12-31' }),
      mk('near', { prio: 'mid', dueDate: '2026-06-01' }),
    ];
    const next = env.api.get(`goalNextStep(${JSON.stringify(subs)})`);
    assert.equal(next.id, 'near');
  });
});

/* ══════════════════════════ F. addSubTask ══════════════════════════ */

describe('F. addSubTask：dir 映射 + cat 继承 + 默认值', () => {
  test('F1 虚拟目标 → dir=null（绝不写入字符串 __inbox__）', () => {
    const env = makeSandbox({ notes: [], directions: [] });
    const n = plain(env.api.get(`addSubTask("__inbox__", "  散装任务  ")`));
    assert.ok(n, 'addSubTask 应返回新 note');
    assert.equal(n.title, '散装任务', 'title 应 trim');
    assert.equal(n.dir, null, '虚拟目标添加的子待办 dir 必须是 null');
    assert.notEqual(n.dir, '__inbox__');
    assert.equal(n.cat, '个人');
    assert.equal(n.prio, 'mid');
    assert.equal(n.status, 'todo');
    assert.equal(n.focus, false);
    assert.equal(n.deleted, false);
    // directions 不被污染
    const dirs = plain(env.api.get('directions'));
    assert.ok(!dirs.some((d) => d.id === '__inbox__'));
  });

  test('F2 真实目标 → dir=gid 且 cat 继承目标', () => {
    const env = makeSandbox({
      notes: [],
      directions: [{ id: 'g1', name: '创业产品', cat: '创业' }],
    });
    const n = plain(env.api.get(`addSubTask("g1", "写 PRD")`));
    assert.equal(n.dir, 'g1');
    assert.equal(n.cat, '创业');
    assert.equal(n.status, 'todo');
  });

  test('F3 空标题返回 null 且不写 notes', () => {
    const env = makeSandbox({ notes: [] });
    assert.equal(env.api.get(`addSubTask("g1", "   ")`), null);
    assert.equal(env.api.get('notes.length'), 0);
  });

  test('F4 添加后持久化链路被触发（saveNotes + scheduleSync）', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    env.api.get(`addSubTask("g1", "x")`);
    assert.ok(env.calls.saveNotes >= 1);
    assert.ok(env.calls.scheduleSync >= 1);
  });
});

/* ══════════════════════════ G. toggleSubDone ══════════════════════════ */

describe('G. toggleSubDone：todo⇄done 四字段同步 + 渲染刷新', () => {
  test('G1 todo → done：status/done/doneAt/updatedAt 同步', () => {
    const notes = [{ id: 'n1', title: 'x', dir: 'g1', status: 'todo', done: false, doneAt: null, updatedAt: 0 }];
    const env = makeSandbox({ notes, directions: [] });
    env.api.get('toggleSubDone("n1")');
    const n = plain(env.api.get('notes[0]'));
    assert.equal(n.status, 'done');
    assert.equal(n.done, true);
    assert.ok(typeof n.doneAt === 'number' && n.doneAt > 0);
    assert.ok(typeof n.updatedAt === 'number');
  });

  test('G2 done → todo：三字段复位', () => {
    const notes = [{ id: 'n1', title: 'x', dir: 'g1', status: 'done', done: true, doneAt: 123, updatedAt: 0 }];
    const env = makeSandbox({ notes, directions: [] });
    env.api.get('toggleSubDone("n1")');
    const n = plain(env.api.get('notes[0]'));
    assert.equal(n.status, 'todo');
    assert.equal(n.done, false);
    assert.equal(n.doneAt, null);
  });

  test('G3 未知 id 静默 no-op', () => {
    const env = makeSandbox({ notes: [{ id: 'n1', title: 'x', status: 'todo', dir: null }] });
    env.api.get('toggleSubDone("nope")');
    assert.equal(env.calls.saveNotes, 0);
  });

  test('G4 完成后重渲染列表与头部（进度即时刷新）', () => {
    const notes = [{ id: 'n1', title: 'x', dir: 'g1', status: 'todo', done: false, doneAt: null }];
    const env = makeSandbox({ notes, directions: [] });
    env.api.set('curGoalId', 'g1');
    env.api.get('toggleSubDone("n1")');
    assert.equal(env.calls.renderGoalSubs, 1);
    assert.equal(env.calls.renderGoalHead, 1);
  });
});

/* ══════════════════════════ H. 三闸门 ══════════════════════════ */

describe('H. 虚拟目标三闸门：任何路径都不得把 __inbox__ 当真实目标处理', () => {
  test('H1 openGoalEdit("__inbox__") 直接 return：不弹窗、不写 editingGoalId', () => {
    const env = makeSandbox({ directions: [], notes: [] });
    env.api.set('editingGoalId', null);
    env.api.get('openGoalEdit("__inbox__")');
    assert.equal(env.calls.openModal.length, 0, '虚拟目标不得打开编辑弹窗');
    assert.equal(env.api.get('editingGoalId'), null, 'editingGoalId 不得被设为虚拟目标');
    assert.ok(env.calls.toast.some((t) => String(t).includes('未归类')), '应有 toast 提示');
  });

  test('H2 saveGoal 在 editingGoalId=__inbox__ 时直接 return，不写 directions', () => {
    const env = makeSandbox({ directions: [{ id: 'g1', name: 'A', cat: '个人', deleted: false }], notes: [] });
    env.api.set('editingGoalId', '__inbox__');
    // 闸门在读取表单前就 return：即使表单有内容也不得写入
    env.api.get('saveGoal()');
    const dirs = plain(env.api.get('directions'));
    assert.deepEqual(dirs.map((d) => d.name), ['A'], 'saveGoal 不得改动 directions');
    assert.equal(env.calls.saveDirections, 0);
  });

  test('H3 deleteGoal 在 editingGoalId=__inbox__ 时直接 return，不删任何东西', () => {
    const env = makeSandbox({ directions: [{ id: 'g1', name: 'A', cat: '个人', deleted: false }], notes: [] });
    env.api.set('editingGoalId', '__inbox__');
    env.api.get('deleteGoal()');
    assert.equal(env.calls.confirmCalls.length, 0, '虚拟目标不应弹确认框');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0].deleted, false);
  });
});

/* ══════════════════════════ I. A-02 行内连续添加（焦点不丢 + IME 保护） ══════════════════════════ */

describe('I. 行内连续添加：输入框 DOM 不重建 + 中文输入法保护', () => {
  test('I1 静态红线：renderGoalSubs / renderGoalHead 不得触碰输入框 DOM', () => {
    const subs = sliceBetween(HTML, 'function renderGoalSubs(gid){', 'function bindGoalSubEvents(){', 'renderGoalSubs');
    const head = sliceBetween(HTML, 'function renderGoalHead(gid){', 'function renderGoalSubs(gid){', 'renderGoalHead');
    for (const [name, src] of [['renderGoalSubs', subs], ['renderGoalHead', head]]) {
      assert.ok(!/goalAddInput/.test(src), `${name} 不得引用 #goalAddInput（会重建输入框导致焦点丢失）`);
      assert.ok(!/goal-add/.test(src), `${name} 不得触碰 .goal-add 容器`);
      assert.ok(!/innerHTML\s*=.*input/i.test(src), `${name} 不得整体重渲染含输入框的区块`);
    }
  });

  test('I2 回车后输入框元素仍是同一引用（不重建 DOM）且 value 清空、焦点保持', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: '创业产品', cat: '创业' }] });
    env.api.set('curGoalId', 'g1');
    const handler = bindKeydown(env);
    const input = env.els['#goalAddInput'];

    input.value = '写 PRD';
    handler({ key: 'Enter', isComposing: false, keyCode: 13, preventDefault() {}, stopPropagation() {}, target: input });
    // 断言 1：输入框元素未被替换（同一引用）
    assert.equal(env.els['#goalAddInput'], input, '回车后输入框 DOM 被重建 → 焦点必然丢失');
    // 断言 2：value 清空
    assert.equal(input.value, '', '回车后输入框应清空');
    // 断言 3：focus 被调用（兜底保焦点）
    assert.ok(input.__focusCount >= 1, '回车后应调用 input.focus()');
    // 断言 4：note 真的加进去了
    const notes = plain(env.api.get('notes'));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, '写 PRD');
    assert.equal(notes[0].dir, 'g1');
    assert.equal(notes[0].cat, '创业');
    // 断言 5：只重渲染子列表与头部（不重渲染整个屏 0）
    assert.equal(env.calls.renderGoalSubs, 1);
    assert.equal(env.calls.renderGoalHead, 1);
    assert.equal(env.calls.renderActHome, 0, '行内添加不得触发整屏重渲染');
  });

  test('I3 中文输入法组合中（isComposing=true）回车不添加', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    env.api.set('curGoalId', 'g1');
    const handler = bindKeydown(env);
    const input = env.els['#goalAddInput'];
    input.value = '买菜';
    handler({ key: 'Enter', isComposing: true, keyCode: 229, target: input });
    assert.equal(env.api.get('notes.length'), 0, '输入法组合中回车不得创建半截拼音待办');
  });

  test('I4 中文输入法组合中（keyCode=229）回车不添加', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    env.api.set('curGoalId', 'g1');
    const handler = bindKeydown(env);
    const input = env.els['#goalAddInput'];
    input.value = '买菜';
    handler({ key: 'Enter', isComposing: false, keyCode: 229, target: input });
    assert.equal(env.api.get('notes.length'), 0);
  });

  test('I5 空输入回车不添加', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    env.api.set('curGoalId', 'g1');
    const handler = bindKeydown(env);
    const input = env.els['#goalAddInput'];
    input.value = '   ';
    handler({ key: 'Enter', isComposing: false, keyCode: 13, target: input });
    assert.equal(env.api.get('notes.length'), 0);
  });

  test('I6 连续添加 3 条：notes 增长、输入框始终同一引用', () => {
    const env = makeSandbox({ notes: [], directions: [{ id: 'g1', name: 'A', cat: '个人' }] });
    env.api.set('curGoalId', 'g1');
    const handler = bindKeydown(env);
    const input = env.els['#goalAddInput'];
    for (const t of ['第一条', '第二条', '第三条']) {
      input.value = t;
      handler({ key: 'Enter', isComposing: false, keyCode: 13, target: input });
    }
    assert.equal(env.api.get('notes.length'), 3);
    assert.equal(env.els['#goalAddInput'], input, '连续添加后输入框引用变化 → 焦点链断裂');
  });
});

/* ══════════════════════════ J. deleteGoal 真删 ══════════════════════════ */

describe('J. deleteGoal：方向软删 + 子待办保留进未归类', () => {
  test('J1 删除后 directions 软删、其子待办 dir 置 null（保留）', () => {
    const env = makeSandbox({
      directions: [{ id: 'g1', name: '创业产品', cat: '创业' }],
      notes: [
        { id: 'n1', title: 'a', dir: 'g1', deleted: false, status: 'todo' },
        { id: 'n2', title: 'b', dir: null, deleted: false, status: 'todo' },
      ],
    });
    env.api.set('editingGoalId', 'g1');
    env.api.get('deleteGoal()');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs[0].deleted, true, '目标应软删');
    const notes = plain(env.api.get('notes'));
    const n1 = notes.find((n) => n.id === 'n1');
    assert.equal(n1.dir, null, '子待办应保留并落入未归类');
    assert.equal(n1.deleted, false, '子待办不得被删');
    // 删除后回屏 0 并刷新首页
    assert.equal(env.api.get('noteScreen'), 0, '删除后应回到总览屏');
    assert.ok(env.calls.renderActHome >= 1);
  });

  test('J2 确认框文案必须明示子待办去向', () => {
    const src = sliceBetween(HTML, 'function deleteGoal(){', '/* ---- 每日复盘 ---- */', 'deleteGoal');
    assert.match(src, /confirm\(/, 'deleteGoal 必须使用 confirm 确认');
    assert.match(src, /子待办会保留|保留在|未归类/, '确认文案未说明子待办去向（需求 A-01 / Q7）');
  });
});
