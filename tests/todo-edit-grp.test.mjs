/**
 * 编辑任务弹窗「分组折叠（方案 A）」验证
 *
 * 仅改 workbench.html / index.html（字节级一致），server.py 未动。
 * 策略与 todo-* 一致：从 workbench.html 抽取真实源码片段，放进带 mini-DOM 的 vm 沙箱真跑。
 *
 * 覆盖：
 *   F1 编辑弹窗含 3 个 .grp 分组容器（core / plan / adv）
 *   F2 高级组默认折叠收起（带 collapsed class，对应 .grp-body 默认 display:none）；核心/计划组默认展开
 *   F3 分组标题点击后高级组可见（在 vm 沙箱真跑 toggleGrp 逻辑）
 *   回归：重组后原输入 id（noteETitle/noteEBody/noteEDir/noteECat/noteEEta/noteEStatus/
 *        noteEFocus/noteEDue/noteEStart/noteEEnd）全部保留，读写逻辑不受影响
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const INDEX = path.join(ROOT, 'index.html');
const HTML = fs.readFileSync(WORKBENCH, 'utf8');

/* 源码抽取：与 todo-* 一致，按标记切片真实代码 */
function sliceBetween(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `抽取失败：找不到起始标记 ${label} → ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.notEqual(b, -1, `抽取失败：找不到结束标记 ${label} → ${endMarker}`);
  return src.slice(a, b);
}

/* 红线：workbench.html 与 index.html 字节级一致 */
test('红线：workbench.html 与 index.html 字节级一致', () => {
  assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未与 workbench.html 同步（分组折叠须双文件同改）');
});

/* F1：编辑弹窗含 3 个 .grp 分组容器 */
test('F1 编辑弹窗包含 3 个分组(.grp)容器', () => {
  const grpDivs = HTML.match(/<div class="grp( collapsed)?" data-grp="(core|plan|adv)">/g) || [];
  assert.equal(grpDivs.length, 3, `应恰好 3 个分组容器，实际 ${grpDivs.length}`);
  for (const k of ['core', 'plan', 'adv']) {
    assert.ok(HTML.includes(`data-grp="${k}"`), `缺少分组 data-grp="${k}"`);
  }
});

/* F2：高级组默认折叠收起；核心/计划组默认展开 */
test('F2 高级组默认折叠收起(collapsed)，核心/计划组默认展开', () => {
  assert.ok(/<div class="grp collapsed" data-grp="adv">/.test(HTML), '高级组应默认带 collapsed class');
  assert.ok(/\.grp\.collapsed \.grp-body\{display:none;\}/.test(HTML), '缺 .grp.collapsed .grp-body{display:none}');
  assert.ok(/<div class="grp" data-grp="core">/.test(HTML), '核心组应默认展开（无 collapsed）');
  assert.ok(/<div class="grp" data-grp="plan">/.test(HTML), '计划组应默认展开（无 collapsed）');
});

/* F3：在 vm 沙箱真跑 toggleGrp，验证点击后高级组可见、再点折叠 */
test('F3 分组标题点击后高级组可见（toggleGrp 真跑）', () => {
  const src = sliceBetween(HTML, 'function toggleGrp(name){', '/* grp-toggle-end */', 'toggleGrp');

  // mini-DOM：三个分组元素，adv 初始 collapsed
  function makeGrp(collapsed) {
    const cls = new Set(collapsed ? ['grp', 'collapsed'] : ['grp']);
    return {
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
        toggle: (c, force) => { const has = cls.has(c); const on = force === undefined ? !has : force; on ? cls.add(c) : cls.delete(c); return on; },
      },
    };
  }
  const reg = {
    '.grp[data-grp="core"]': makeGrp(false),
    '.grp[data-grp="plan"]': makeGrp(false),
    '.grp[data-grp="adv"]': makeGrp(true),
  };
  const sandbox = { document: { querySelector: (sel) => reg[sel] || null }, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const adv = reg['.grp[data-grp="adv"]'];
  assert.equal(adv.classList.contains('collapsed'), true, '初始应折叠');

  vm.runInContext('toggleGrp("adv")', sandbox);
  assert.equal(adv.classList.contains('collapsed'), false, '点击后高级组应展开（可见）');

  vm.runInContext('toggleGrp("adv")', sandbox);
  assert.equal(adv.classList.contains('collapsed'), true, '再次点击应重新折叠');

  // 点击绑定存在（.grp-title 事件委托）
  assert.ok(/grp-title/.test(HTML), '弹窗应包含 .grp-title 及点击绑定');
  assert.ok(/\$\$\("\.grp-title"\)\.forEach/.test(HTML), '缺少 .grp-title 的点击事件绑定');
});

/* 回归：重组后原输入 id 全部保留（读写逻辑依赖这些 id，不能丢失/改名） */
test('回归：重组后原输入 id 全部保留', () => {
  for (const id of ['noteETitle', 'noteEBody', 'noteEDir', 'noteECat', 'noteEEta', 'noteEStatus', 'noteEFocus', 'noteEDue', 'noteEStart', 'noteEEnd']) {
    assert.ok(HTML.includes(`id="${id}"`), `缺少输入 id="${id}"（重组不应丢失/改名）`);
  }
  // 轻重缓急分段控件容器保留
  assert.ok(HTML.includes('id="noteEPrio"') && HTML.includes('class="dj-mood"'), '轻重缓急分段控件应保留');
  // 时间线文案已更新为「跨天任务自动进入聚焦」，消除与「设为今日聚焦」的困惑
  assert.ok(HTML.includes('时间线（跨天任务自动进入聚焦）'), '时间线文案应更新为「跨天任务自动进入聚焦」');
  // 快捷日期按钮保留
  for (const q of ['today', 'tomorrow', 'week', '']) {
    assert.ok(HTML.includes(`data-quickdue="${q}"`), `缺少快捷日期按钮 data-quickdue="${q}"`);
  }
});
