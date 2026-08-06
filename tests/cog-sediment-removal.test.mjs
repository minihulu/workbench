/**
 * 认知资产 —— 「读后沉淀」功能移除 回归测试
 *
 * 背景：删除了阅读页的「读后沉淀」输入区（最终总结 / 核心观点 / 我的评价 + 保存沉淀按钮）、
 *       其绑定与保存函数，以及书籍详情弹窗中对应的 3 行展示字段。
 *
 * 策略：与 pdf-render.test.mjs 一致 —— 不重新实现逻辑，而是对 workbench.html 真实源码做
 *       结构 / 语法 / 引用不变量断言。源码一旦回退或删漏，测试立刻失败。
 *
 * 覆盖：
 *   A 语法 & 双文件一致性
 *   B 沉淀相关符号彻底移除（无残留引用）
 *   C 阅读页模板字符串完整闭合（删除点前后结构正确）
 *   D 既有阅读页功能未被误删（元素 + 事件绑定成对存在）
 *   E 书籍详情弹窗仅删 3 行，其余字段完好
 *   F 孤儿数据字段不再被任何代码读写（不会产生运行时未定义引用）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// QA_TARGET_HTML 用于变异测试（对故意注入缺陷的副本跑同一套断言，验证测试确实有杀伤力）
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const INDEX = path.join(ROOT, 'index.html');
const HTML = fs.readFileSync(WORKBENCH, 'utf8');

/** 抽出主 <script> 内的纯 JS（用于语法校验与「仅 JS 范围」的断言） */
function extractMainScript(src) {
  const open = src.indexOf('<script>');
  assert.notEqual(open, -1, '找不到主 <script> 起始标签');
  const close = src.indexOf('</script>', open);
  assert.notEqual(close, -1, '找不到主 <script> 结束标签');
  return src.slice(open + '<script>'.length, close);
}

const SCRIPT = extractMainScript(HTML);

/** 取「书籍信息面板」模板（renderBookInfo，含 状态/进度/片段列表）到其闭合处的整段源码。
 *  注意：读后沉淀移除 + T04 书架重构后，文件源预览(renderCogReading) 与 书籍信息面板(renderBookInfo)
 *  已是两份独立模板。本文件关心的是「以 cogExcerptList 收尾」的那一份，故直接锚定 cogExcerptList。 */
function readingTemplateRegion(src) {
  const cogList = src.indexOf('id="cogExcerptList"');
  assert.notEqual(cogList, -1, '找不到 cogExcerptList（删除范围过大）');
  // 向前找最近的 box.innerHTML = ` 模板起点（renderBookInfo 的面板模板）
  const start = src.lastIndexOf('box.innerHTML = `', cogList);
  assert.notEqual(start, -1, '找不到书籍信息面板模板起始 box.innerHTML = `');
  // 模板以「反引号 + 分号」闭合
  const end = src.indexOf('`;', start + 'box.innerHTML = `'.length);
  assert.notEqual(end, -1, '找不到书籍信息面板模板的闭合 `;');
  return src.slice(start, end + 2);
}

/* ────────────────────────── A 语法 & 一致性 ────────────────────────── */

describe('A 语法与双文件一致性', () => {
  test('主 <script> 是合法 JS（能被解析）', () => {
    // 用 Function 构造做语法校验：语法错误会抛 SyntaxError，且不会执行函数体
    assert.doesNotThrow(
      () => new Function(SCRIPT),
      '主 <script> 存在语法错误（模板字符串可能未正确闭合）'
    );
  });

  test('workbench.html 与 index.html 完全一致（构建副本已同步）', () => {
    if (process.env.QA_TARGET_HTML) return; // 变异测试时跳过
    const a = fs.readFileSync(path.join(ROOT, 'workbench.html'), 'utf8');
    const b = fs.readFileSync(INDEX, 'utf8');
    assert.equal(a, b, 'workbench.html 与 index.html 不一致，构建副本未同步');
  });

  test('主 <script> 内反引号数量为偶数（模板字符串成对）', () => {
    // 去掉转义反引号后统计，奇数说明有未闭合的模板字符串
    const ticks = (SCRIPT.replace(/\\`/g, '').match(/`/g) || []).length;
    assert.equal(ticks % 2, 0, `反引号数量为奇数(${ticks})，存在未闭合的模板字符串`);
  });
});

/* ────────────────────────── B 沉淀符号彻底移除 ────────────────────────── */

describe('B 读后沉淀相关符号已彻底移除', () => {
  const FORBIDDEN_JS = [
    'saveCogSediment',
    'crSedimentSave',
    'crSummary',
    'crViews',
    'crReview',
    'cbdSummary',
    'cbdViews',
    'cbdReview',
  ];

  for (const sym of FORBIDDEN_JS) {
    test(`标识符 ${sym} 在 HTML 中零残留`, () => {
      assert.equal(HTML.includes(sym), false, `仍存在残留引用：${sym}`);
    });
  }

  for (const zh of ['读后沉淀', '保存沉淀']) {
    test(`文案「${zh}」零残留`, () => {
      assert.equal(HTML.includes(zh), false, `仍存在残留文案：${zh}`);
    });
  }

  test('阅读页模板中不再包含 read-sediment 容器', () => {
    const region = readingTemplateRegion(HTML);
    assert.equal(
      /class="read-sediment"/.test(region),
      false,
      '阅读页模板中仍存在 <div class="read-sediment">'
    );
  });
});

/* ────────────────────────── C 模板闭合完整性 ────────────────────────── */

describe('C 阅读页模板字符串完整闭合', () => {
  test('模板以 cogExcerptList 结尾并正确闭合', () => {
    const region = readingTemplateRegion(HTML);
    assert.ok(
      region.includes('id="cogExcerptList"'),
      '阅读页模板中缺少 cogExcerptList（删除范围过大）'
    );
    // 删除点之后应紧跟闭合：cogExcerptList 的 div 之后除空白外只剩 `;
    const tail = region.slice(region.indexOf('id="cogExcerptList"'));
    assert.match(
      tail,
      /id="cogExcerptList"[^`]*?><\/div>\s*`;$/,
      '模板结尾结构异常：cogExcerptList 之后未紧跟闭合的 `;'
    );
  });

  test('模板内 div 开闭标签数量平衡', () => {
    const region = readingTemplateRegion(HTML);
    const open = (region.match(/<div\b/g) || []).length;
    const close = (region.match(/<\/div>/g) || []).length;
    assert.equal(open, close, `阅读页模板 div 不平衡：${open} 开 / ${close} 闭`);
  });

  test('模板闭合后紧接的绑定代码仍存在（未被吞掉）', () => {
    const after = SCRIPT.slice(
      SCRIPT.indexOf('id="cogExcerptList"')
    );
    assert.ok(after.includes('$("#crStatus").value'), '模板之后的状态回填代码丢失');
    // P0 把 crProgSave 改为条件渲染 + 空值保护：按钮仅在 !auto 时渲染，
    // 绑定写成 `const ps = $("#crProgSave"); if(ps) ps.onclick = saveCogProgress;`
    // （不再是字面量 `$("#crProgSave").onclick = saveCogProgress`）。放宽成「就近出现 onclick=saveCogProgress」。
    assert.ok(/#crProgSave[\s\S]{0,80}onclick\s*=\s*saveCogProgress/.test(after), '模板之后的进度保存绑定丢失');
  });
});

/* ────────────────────────── D 既有功能未被误删 ────────────────────────── */

describe('D 认知资产阅读页既有功能完好', () => {
  // [元素 id, 该元素必须存在的绑定/使用代码片段]
  const CASES = [
    ['crStatus', '$("#crStatus").onchange = saveCogProgress'],
    ['crProg', 'progEl.onchange = saveCogProgress'],
    ['crProgSave', 'const ps = $("#crProgSave"); if(ps) ps.onclick = saveCogProgress'],
    ['crPos', '$("#crPos").onblur = saveCogProgress'],
    ['crExcerpt', '$("#crExcerpt").value.trim()'],
    ['crExcerptAdd', '$("#crExcerptAdd").onclick'],
    ['cogExcerptList', '$("#cogExcerptList")'],
    ['crUploadFile', '$("#crUploadFile")'],
    ['crFileBox', '$("#crFileBox")'],
  ];

  for (const [id, binding] of CASES) {
    test(`${id} 元素存在且调用链未断`, () => {
      assert.ok(HTML.includes(`id="${id}"`), `阅读页缺少元素 id="${id}"`);
      assert.ok(SCRIPT.includes(binding), `${id} 的绑定/使用代码丢失：${binding}`);
    });
  }

  test('saveCogProgress 函数仍有定义', () => {
    assert.match(SCRIPT, /function saveCogProgress\s*\(/, 'saveCogProgress 定义丢失');
  });

  test('renderCogReadingFile 函数仍有定义（文件上传链路）', () => {
    assert.match(SCRIPT, /function renderCogReadingFile\s*\(/, 'renderCogReadingFile 定义丢失');
  });
});

/* ────────────────────────── E 书籍详情弹窗 ────────────────────────── */

describe('E 书籍详情弹窗仅删除沉淀 3 行', () => {
  for (const id of ['cbdTitle', 'cbdMeta', 'cbdRecords', 'cbdEdit', 'cbdClose']) {
    test(`弹窗字段 ${id} 仍存在`, () => {
      assert.ok(HTML.includes(`id="${id}"`), `书籍详情弹窗缺少 id="${id}"`);
    });
  }

  test('openCogBookDetail 仍回填标题/元信息/阅读记录', () => {
    assert.ok(SCRIPT.includes('$("#cbdTitle").textContent'), 'cbdTitle 回填丢失');
    assert.ok(SCRIPT.includes('$("#cbdMeta").innerHTML'), 'cbdMeta 回填丢失');
    assert.ok(SCRIPT.includes('$("#cbdRecords").innerHTML'), 'cbdRecords 回填丢失');
  });

  test('弹窗开关函数完好', () => {
    assert.match(SCRIPT, /function openCogBookDetail\s*\(/, 'openCogBookDetail 丢失');
    assert.match(SCRIPT, /function closeCogBookDetail\s*\(/, 'closeCogBookDetail 丢失');
    assert.ok(SCRIPT.includes('$("#cbdClose").onclick'), 'cbdClose 绑定丢失');
  });
});

/* ────────────────────────── F 孤儿数据字段 ────────────────────────── */

describe('F 沉淀数据字段不再被读写', () => {
  // 删除 UI 后，b.summary / b.viewpoints / b.review 应彻底无人引用，
  // 否则说明删漏了「读」的一侧，会在运行时读到 undefined。
  for (const field of ['.summary', '.viewpoints', '.review']) {
    test(`JS 中不再引用 ${field}`, () => {
      // 只在 JS 范围内匹配属性访问，避免误伤 CSS 类名（如 .review-grid）
      const re = new RegExp(`\\${field}\\b(?!-)`, 'g');
      const hits = SCRIPT.match(re) || [];
      assert.equal(
        hits.length,
        0,
        `JS 中仍引用已废弃字段 ${field}（${hits.length} 处），存在删漏`
      );
    });
  }
});
