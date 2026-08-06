/**
 * 高亮锚定层 CSS 不变量 —— `.anno` 裸类名不能泄漏到正文文字层 span
 *
 * 背景（T02/T03 范围内的一处 SOURCE 缺陷）：
 *   - `applyAnnos` 给文字层 span 加的是裸类名 `sp.classList.add('anno')`（workbench.html L4334）
 *   - 但 `.anno{...padding:13px; border:1px solid var(--line); margin-bottom:10px; box-shadow:var(--shadow);}`
 *     是一条「书卡」用的裸规则（L582），会落到每个高亮 span 上；
 *   - 文字层 span 是 `position:absolute + transform:matrix()` 定位的，13px 内边距会让高亮块整体胀大，
 *     还会给每段高亮画出可见边框 + 投影 —— 视觉与布局都错。
 *   - 对口规则 `.pdf-page .textLayer span.anno` 当前只声明了 `border-radius:2px; cursor:pointer;`，
 *     没有重置 padding/border/margin/box-shadow ⇒ 泄漏成立。
 *
 * 这条锁断言「文字层 span.anno 的专用规则必须把 box 尺寸相关属性全部清零」，
 * 修复只需在 L524 该规则补上 `padding:0; border:0; margin:0; box-shadow:none;`（一行）。
 * 当前源码未修，故本文件跑出来是 **RED** —— 这正是「测试正确、实现有 bug」的路由信号，
 * 已上报 software-engineer 修复；修完即转绿。
 *
 * 注意：本文件只锁 CSS 不变量，侧栏 JS 行为由 tests/pdf-anno-sidebar.test.mjs 覆盖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const HTML = fs.readFileSync(WORKBENCH, 'utf8');

/** 取 CSS 里某条规则的声明体（不含选择器与外层花括号） */
function ruleBody(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}');
  const m = css.match(re);
  assert.ok(m, `找不到 CSS 规则：${selector}`);
  return m[1];
}

describe('高亮锚定层 span.anno 不被 .anno 裸规则污染', () => {
  const SEL = '.pdf-page .textLayer span.anno';
  let body;
  test('前置：能定位到文字层 span.anno 专用规则', () => {
    body = ruleBody(HTML, SEL);
    // 至少已声明这两项是历史就有的
    assert.ok(/border-radius:2px/.test(body), 'span.anno 缺少 border-radius 重置');
    assert.ok(/cursor:pointer/.test(body), 'span.anno 缺少 cursor 重置');
  });

  for (const prop of ['padding:0', 'border:0', 'margin:0', 'box-shadow:none']) {
    test(`span.anno 专用规则必须重置 ${prop}（否则裸 .anno 的 ${prop.replace(':0', '')} 会泄漏到高亮块）`, () => {
      assert.ok(body.includes(prop), `span.anno 缺少重置 ${prop} —— 高亮 span 会被 .anno 裸规则撑大/描边/投影`);
    });
  }

  test('裸 .anno 规则确实存在（书卡用，含 padding:13px + box-shadow），证明泄漏来源存在', () => {
    // 直接锁定「.anno{...padding:13px...box-shadow:var(--shadow)...}」这条书卡裸规则
    assert.match(HTML, /\.anno\{[^}]*padding:13px[^}]*box-shadow:var\(--shadow\)[^}]*\}/,
      '前提不成立：找不到带 padding:13px/box-shadow 的裸 .anno 书卡规则（泄漏源）');
  });
});
