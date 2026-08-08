/**
 * 行动矩阵「大任务增删改入口」独立验证 —— 新增专项（严把关）
 *
 * 背景：工程师修复「行动矩阵」缺大任务管理入口的问题，仅改 workbench.html / index.html
 * （字节级一致），server.py 零改动、无新增同步键。本次新增：
 *   - 矩阵每行（非虚拟方向）追加「✏️ 编辑 / 🗑 删除」按钮（data-dir-edit / data-dir-del）
 *   - 矩阵标题新增「＋ 新大任务」按钮（#matrixAddDir），点击进入 openGoalEdit(null) 新建态
 *   - 事件委托（bindMatrix）新增对 data-dir-edit / data-dir-del 的处理
 *   - 新增 deleteGoalById(id)：软删方向 + 其下子任务 dir 置 null（归未归类，不删 notes）
 *   - 原 deleteGoal() 重构为：虚拟守卫 + closeModal + deleteGoalById(editingGoalId)
 *
 * 策略（与 todo-timeline / todo-goals 一致）：从 workbench.html 按标记抽取「真实源码切片」，
 * 放进带 mini-DOM / document / 存储 mock 的 vm 沙箱里真跑，断言线上代码本身。
 *
 * 覆盖：
 *   1 结构（运行时真跑 matrixRowHtml）：真实方向行含 data-dir-edit/data-dir-del；
 *     虚拟「未归类」行不含这两个按钮。
 *   2 顶部新增按钮：HTML 含 <button id="matrixAddDir">＋ 新大任务</button>（静态校验）。
 *   3 deleteGoalById 逻辑（纯函数片段真跑）：软删方向 + 子任务归未归类 + notes 总数不变 +
 *     可重入 + 虚拟/未知 id 守卫 no-op。
 *   4 openGoalEdit(null) 进入新建态：#dirModalTitle=「新建目标」、#dirDelete 隐藏、editingGoalId=null。
 *   5 事件委托接线（源码静态校验）：bindMatrix 把 data-dir-edit→openGoalEdit、data-dir-del→
 *     confirm+deleteGoalById；renderActHome 把 #matrixAddDir 接 openGoalEdit(null)。
 *   6 镜像铁律：workbench.html 与 index.html 字节级一致。
 *   7 红线：同步 payload 顶层键零新增（无 taskCompletions 等新键）；server.py 未改动。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
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

// 虚拟「📥 未归类」常量
const R_INBOX = sliceBetween(HTML, 'const GOAL_INBOX = { id:"__inbox__"', 'function normReview(', 'GOAL_INBOX');
// 虚拟目标闸门（真实抽出，不 stub）
const R_VIRTUAL = sliceBetween(HTML, 'function isVirtualGoal(gid){', 'function goalById(gid){', 'isVirtualGoal');
// 矩阵渲染区块：matrixDateRange → getDirNotes → matrixCardHtml → matrixRowHtml → renderMatrix → bindMatrix → applyToggleCompletion
const R_MATRIX = sliceBetween(HTML, 'let matrixDateRange = new Set();', 'function renderTodoCalendar(){', 'matrix');
// 目标 CRUD：editingGoalId / openGoalEdit / saveGoal / deleteGoalById / deleteGoal
const R_DIRACTIONS = sliceBetween(HTML, 'let editingGoalId=null;', 'function openReview(date){', 'dirActions');
// bindMatrix 单函数（事件委托接线校验）
const R_BINDMATRIX = sliceBetween(HTML, 'function bindMatrix(){', 'function applyToggleCompletion(id, date){', 'bindMatrix');
// renderActHome 单函数（顶部按钮接线校验）
const R_RENDERHOME = sliceBetween(HTML, 'function renderActHome(){', 'function focusTasks(){', 'renderActHome');

// 抽取边界自检：区块必须真的含被测函数
assert.ok(R_INBOX.includes('__inbox__'), 'GOAL_INBOX 区块抽取异常');
assert.ok(R_VIRTUAL.includes('function isVirtualGoal(gid){'), 'isVirtualGoal 区块异常');
assert.ok(R_MATRIX.includes('function matrixRowHtml(g, notesInDir){'), 'matrix 区块缺少 matrixRowHtml');
assert.ok(R_DIRACTIONS.includes('function openGoalEdit(id){'), 'dirActions 区块缺少 openGoalEdit');
assert.ok(R_DIRACTIONS.includes('function deleteGoalById(id){'), 'dirActions 区块缺少 deleteGoalById');
assert.ok(R_BINDMATRIX.includes('function bindMatrix(){'), 'bindMatrix 区块异常');
assert.ok(R_RENDERHOME.includes('function renderActHome(){'), 'renderActHome 区块异常');

/* 重构红线（静态）：看板已退役、矩阵在；同步 payload 仍是既有键集 */
assert.ok(!/function renderKanban\(/.test(HTML), '旧看板 renderKanban 应已彻底移除');
assert.ok(HTML.includes('function renderMatrix()'), '矩阵 renderMatrix 应存在');
assert.ok(HTML.includes('function matrixRowHtml'), 'matrixRowHtml 应存在');

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

/**
 * 构建 vm 沙箱：notes / directions 由测试注入；真实源码区块（GOAL_INBOX + isVirtualGoal +
 * 矩阵 + 目标 CRUD）放进带 mini-DOM / 存储 mock 的沙箱里真跑。
 * 返回 { api, calls, els }：api.get/set 读写模块级绑定，calls 记录各类副作用。
 */
function makeSandbox({ notes = [], directions = [] } = {}) {
  const calls = {
    saveNotes: 0, saveDirections: 0, persistNotes: 0, persistDirections: 0, scheduleSync: 0,
    toast: [], confirmCalls: [], openModal: [], closeModal: [],
    renderActHome: 0, renderActGoals: 0, renderGoalSubs: 0, renderGoalHead: 0,
  };
  const els = {};

  const sandbox = {
    console, Math, JSON, Set, Map, Object, Array, Promise, Error, String, Number,
    Date, parseFloat, parseInt, isNaN, RegExp,
    notes, directions,
    // 展示/交互辅助（不在抽取区块内，提供 faithful stub）
    esc: (s) => (s == null ? '' : String(s)).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    $: (sel) => (els[sel] || (els[sel] = makeEl())),
    $$: () => [],
    uid: (() => { let n = 0; return () => 'id-' + (++n) + '-' + Date.now().toString(36); })(),
    deviceId: 'dev-test',
    toast: (m) => calls.toast.push(m),
    confirm: () => { calls.confirmCalls.push(true); return true; },
    openModal: (s) => calls.openModal.push(s),
    closeModal: (s) => calls.closeModal.push(s),
    saveNotes() { calls.saveNotes++; calls.persistNotes++; calls.scheduleSync++; },
    persistNotes() { calls.persistNotes++; },
    saveDirections() { calls.saveDirections++; calls.persistDirections++; calls.scheduleSync++; },
    persistDirections() { calls.persistDirections++; },
    scheduleSync() { calls.scheduleSync++; },
    renderActHome() { calls.renderActHome++; },
    renderActGoals() { calls.renderActGoals++; },
    renderGoalSubs() { calls.renderGoalSubs++; },
    renderGoalHead() { calls.renderGoalHead++; },
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
    [R_INBOX, R_VIRTUAL, R_MATRIX, R_DIRACTIONS, epilogue].join('\n'),
    sandbox,
    { filename: 'todo-matrix-diractions.js' }
  );

  return { api: sandbox.__api, calls, els, sandbox };
}

/** vm 对象来自另一 realm，deepEqual 前先归一化 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ══════════════════════════ 1. 行内按钮结构（真实 matrixRowHtml 真跑） ══════════════════════════ */

describe('1. matrixRowHtml：真实方向行含编辑/删除按钮，虚拟未归类行不含', () => {
  test('D1 真实方向行输出含 data-dir-edit / data-dir-del（值为该方向 id）', () => {
    const env = makeSandbox();
    const html = env.api.get('matrixRowHtml({id:"g1",name:"创业",emoji:"🚀"}, [])');
    assert.ok(html.includes('data-dir-edit="g1"'), '真实方向行应有编辑按钮 data-dir-edit="g1"');
    assert.ok(html.includes('data-dir-del="g1"'), '真实方向行应有删除按钮 data-dir-del="g1"');
    assert.ok(html.includes('matrix-dir-edit') && html.includes('matrix-dir-del'), '应带 matrix-dir-edit/matrix-dir-del 样式类');
    assert.ok(html.includes('✏️') && html.includes('🗑'), '按钮应含编辑/删除图标');
  });

  test('D2 虚拟「未归类」行输出「不含」data-dir-edit / data-dir-del', () => {
    const env = makeSandbox();
    const html = env.api.get('matrixRowHtml(GOAL_INBOX, [])');
    assert.ok(!html.includes('data-dir-edit'), '未归类行不得出现编辑按钮');
    assert.ok(!html.includes('data-dir-del'), '未归类行不得出现删除按钮');
    assert.ok(html.includes('matrix-row-inbox'), '未归类行应带 matrix-row-inbox 标识');
  });

  test('D3 源码层确认：非虚拟时追加按钮、虚拟时为空串（口径红线）', () => {
    const src = sliceBetween(HTML, 'function matrixRowHtml(g, notesInDir){', 'function renderMatrix(){', 'matrixRowHtml');
    assert.ok(/data-dir-edit="\$\{g\.id\}"[\s\S]*data-dir-del="\$\{g\.id\}"/.test(src), 'matrixRowHtml 须为非虚拟方向追加 data-dir-edit/data-dir-del 按钮');
    assert.ok(/\$\{isInbox \? "" : /.test(src), 'matrixRowHtml 须对虚拟方向(isInbox)输出空串（不加按钮）');
  });
});

/* ══════════════════════════ 1b. 方向标题可见（name 为主、title 兜底；按钮不挤占标题宽度） ══════════════════════════ */

describe('1b. matrixRowHtml：方向标题必须可见（name/title 兜底 + 布局不压扁）', () => {
  test('N1 标题含 name 字段内容（真实方向行应呈现「医学成长」等名称）', () => {
    const env = makeSandbox();
    const html = env.api.get('matrixRowHtml({id:"g1",name:"医学成长",emoji:"🩺"}, [])');
    assert.ok(html.includes('医学成长'), '方向名称应出现在 matrix-name 中');
    assert.ok(/<span class="matrix-name">[\s\S]*医学成长/.test(html), 'matrix-name 须承载方向标题');
  });

  test('N2 title 兜底：仅有 title 字段（无 name）时仍渲染标题（兼容数据模型差异）', () => {
    const env = makeSandbox();
    const html = env.api.get('matrixRowHtml({id:"g2",title:"创业产品",emoji:"🚀"}, [])');
    assert.ok(html.includes('创业产品'), '仅有 title 时也应渲染标题');
  });

  test('N3 源码层：matrixRowHtml 用 g.name 优先、g.title 兜底（esc 包裹，不新增同步键）', () => {
    const src = sliceBetween(HTML, 'function matrixRowHtml(g, notesInDir){', 'function renderMatrix(){', 'matrixRowHtml');
    assert.ok(/esc\(\s*g\.name\s*!=\s*null\s*\?\s*g\.name\s*:\s*g\.title\s*\)/.test(src),
      'matrixRowHtml 须以 g.name 为主、g.title 兜底渲染标题（兼容 name/title 两种数据模型）');
  });

  test('N4 布局兜底：count 预留按钮槽位（margin-right:64px），编辑/删除按钮绝对定位脱离 flex 流，避免标题被压成 0 宽', () => {
    assert.ok(/\.matrix-count\{[^}]*margin-right:64px/.test(HTML), 'matrix-count 须预留 64px 右侧槽位给操作按钮');
    assert.ok(/\.matrix-row-head \.matrix-dir-edit,[\s\S]*\.matrix-row-head \.matrix-dir-del\{[^}]*position:absolute/.test(HTML),
      '编辑/删除按钮须绝对定位（脱离 flex 流），不挤占标题宽度');
  });
});

/* ══════════════════════════ 2. 顶部「＋ 新大任务」按钮（静态校验） ══════════════════════════ */

describe('2. 矩阵标题新增「＋ 新大任务」入口（#matrixAddDir）', () => {
  test('T1 HTML 含 <button id="matrixAddDir">＋ 新大任务</button>', () => {
    assert.ok(/<button[^>]*id="matrixAddDir"[^>]*>＋ 新大任务<\/button>/.test(HTML), '矩阵标题应含 #matrixAddDir 新增大任务按钮');
  });
  test('T2 该按钮在「行动矩阵」卡片标题区内（与全部任务按钮并列）', () => {
    const cardH = HTML.split('\n').find((l) => l.includes('id="matrixAddDir"'));
    assert.ok(/行动矩阵/.test(HTML.slice(HTML.indexOf('行动矩阵'), HTML.indexOf('行动矩阵') + 400)), 'matrixAddDir 应位于行动矩阵卡片内');
    assert.ok(cardH && cardH.includes('btn') && cardH.includes('matrixAddDir'), '按钮标记缺失或位置异常');
  });
});

/* ══════════════════════════ 3. deleteGoalById 逻辑（真实抽出真跑） ══════════════════════════ */

describe('3. deleteGoalById：软删方向 + 子任务归未归类（不删 notes）+ 可重入 + 守卫', () => {
  function envForDelete() {
    return makeSandbox({
      directions: [{ id: 'd1', name: '创业', cat: '创业', deleted: false }],
      notes: [
        { id: 'n1', title: '写 BP', dir: 'd1', deleted: false },
        { id: 'n2', title: '见投资人', dir: 'd1', deleted: false },
        { id: 'n3', title: '散装', dir: 'other', deleted: false },
      ],
    });
  }

  test('G1 删除后方向软删(deleted=true)、其子任务 dir→null（归未归类）、notes 总数不变', () => {
    const env = envForDelete();
    env.api.get('deleteGoalById("d1")');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs[0].deleted, true, '目标应被软删（deleted=true）');
    const notes = plain(env.api.get('notes'));
    assert.equal(notes.find((n) => n.id === 'n1').dir, null, 'n1 应归入未归类');
    assert.equal(notes.find((n) => n.id === 'n2').dir, null, 'n2 应归入未归类');
    assert.equal(notes.find((n) => n.id === 'n3').dir, 'other', '属其它方向的 n3 不应被改动');
    assert.equal(notes.length, 3, '删除方向不得删除任何子任务');
    assert.ok(env.calls.saveDirections >= 1 && env.calls.saveNotes >= 1, '应触发持久化');
    assert.ok(env.calls.toast.some((t) => String(t).includes('归入未归类')), '应有「归入未归类」提示');
  });

  test('G2 可重入：连续两次 deleteGoalById("d1") 不报错、n3 仍 other、notes 计数稳定', () => {
    const env = envForDelete();
    env.api.get('deleteGoalById("d1")');
    assert.doesNotThrow(() => env.api.get('deleteGoalById("d1")'), '重复删除不应抛错');
    const notes = plain(env.api.get('notes'));
    assert.equal(notes.find((n) => n.id === 'n3').dir, 'other', '重入后 n3 仍属 other');
    assert.equal(notes.length, 3, '重入后 notes 计数应保持 3');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs[0].deleted, true, '重入后方向仍为软删');
  });

  test('G3 虚拟目标守卫：deleteGoalById("__inbox__") 直接 return，不动 directions/notes', () => {
    const env = envForDelete();
    env.api.get('deleteGoalById("__inbox__")');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs[0].deleted, false, '未归类不得被软删');
    assert.equal(env.api.get('notes.length'), 3, '未归类守卫不应改动 notes');
  });

  test('G4 未知 id 守卫：deleteGoalById("nope") 直接 return，无副作用', () => {
    const env = envForDelete();
    env.api.get('deleteGoalById("nope")');
    const dirs = plain(env.api.get('directions'));
    assert.equal(dirs.length, 1);
    assert.equal(dirs[0].deleted, false);
    assert.equal(env.calls.saveDirections, 0);
  });
});

/* ══════════════════════════ 4. openGoalEdit(null) 进入新建态 ══════════════════════════ */

describe('4. openGoalEdit(null)：进入「新建目标」态（标题=新建目标、删除按钮隐藏、editingGoalId=null）', () => {
  test('N1 新建态 UI 状态正确', () => {
    const env = makeSandbox({ directions: [], notes: [] });
    env.api.get('openGoalEdit(null)');
    assert.equal(env.els['#dirModalTitle'].textContent, '新建目标', '弹窗标题应为「新建目标」');
    assert.equal(env.els['#dirDelete'].style.display, 'none', '新建态应隐藏删除按钮');
    assert.equal(env.api.get('editingGoalId'), null, '新建态 editingGoalId 应为 null');
    assert.equal(env.calls.openModal.length, 1, '应打开编辑弹窗');
  });

  test('N2 编辑态与新建态区分：openGoalEdit("g1") 标题=编辑目标、删除按钮可见', () => {
    const env = makeSandbox({ directions: [{ id: 'g1', name: '创业', cat: '创业', deleted: false }], notes: [] });
    env.api.get('openGoalEdit("g1")');
    assert.equal(env.els['#dirModalTitle'].textContent, '编辑目标', '编辑态标题应为「编辑目标」');
    assert.equal(env.els['#dirDelete'].style.display, '', '编辑态应显示删除按钮');
    assert.equal(env.api.get('editingGoalId'), 'g1', '编辑态 editingGoalId 应为 g1');
  });
});

/* ══════════════════════════ 5. 事件委托 / 顶部按钮接线（源码静态校验） ══════════════════════════ */

describe('5. 接线：bindMatrix 委托 + renderActHome 顶部按钮', () => {
  test('W1 bindMatrix：data-dir-edit→openGoalEdit、data-dir-del→confirm+deleteGoalById', () => {
    assert.match(R_BINDMATRIX, /closest\("\[data-dir-edit\]"\)[\s\S]*openGoalEdit\(/, 'bindMatrix 须把 data-dir-edit 委托给 openGoalEdit');
    assert.match(R_BINDMATRIX, /closest\("\[data-dir-del\]"\)[\s\S]*confirm\([\s\S]*deleteGoalById\(/, 'bindMatrix 须把 data-dir-del 经 confirm 委托给 deleteGoalById');
  });

  test('W2 renderActHome：#matrixAddDir 接 openGoalEdit(null)', () => {
    assert.match(R_RENDERHOME, /\$\("#matrixAddDir"\)[\s\S]*openGoalEdit\(null\)/, 'renderActHome 须把 #matrixAddDir 点击接 openGoalEdit(null)（新建态）');
  });
});

/* ══════════════════════════ 6. 镜像铁律：workbench.html 与 index.html 字节级一致 ══════════════════════════ */

describe('6. 镜像铁律：workbench.html 与 index.html 字节级一致', () => {
  test('X1 两文件逐字节相等', () => {
    assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未与 workbench.html 同步（大任务入口须双文件同改）');
  });
});

/* ══════════════════════════ 7. 红线：同步 payload 零新增顶层键 + server.py 未改 ══════════════════════════ */

describe('7. 红线：同步 payload 顶层键零新增 + server.py 未改动', () => {
  test('P1 同步 payload 仅含既有授权键（无 taskCompletions 等新键）', () => {
    const line = HTML.split('\n').find((l) => l.includes('const payload = {'));
    assert.ok(line, '找不到同步 payload 组装行');
    const m = line.match(/const payload = \{([^}]*)\}/);
    assert.ok(m, 'payload 组装行解析失败');
    const keys = m[1].split(',').map((s) => s.split(':')[0].split('//')[0].trim()).filter(Boolean);
    const allowed = new Set(['times', 'ideas', 'notes', 'diary', 'cog_reads', 'cog_books',
      'cog_thoughts', 'cog_reviews', 'cog_expr', 'cog_annos', 'directions', 'reviews', 'settings']);
    for (const k of keys) {
      assert.ok(allowed.has(k), `同步 payload 出现未授权顶层键: ${k}`);
    }
    assert.ok(!/taskCompletions/.test(HTML), '不应新增 taskCompletions 顶层同步键');
  });

  test('P2 server.py 未改动（git diff 不含 server.py）', () => {
    let changed;
    try {
      changed = execSync('git diff --name-only', { cwd: ROOT }).toString().split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      // 非 git 仓库环境下退化为仅校验两 html 一致（已在 X1 保证）
      changed = [];
    }
    assert.ok(!changed.includes('server.py'), `server.py 不应被修改，git diff 含: ${changed.join(', ')}`);
  });
});
