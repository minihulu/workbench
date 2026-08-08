/**
 * 认知资产 + 英语助手 回归锁
 *
 * 覆盖本期（T01–T05）的关键不变量：
 *  1. 字节级一致铁律：workbench.html 与 index.html 必须完全相同（任一改动后必 cp）。
 *  2. 浮层/查词/翻译基础设施存在（DictLoader / lookupWord / 查词翻译按钮 / 浮层函数）。
 *  3. 模块收起 + 英语助手更名：首页「更多」折叠、屏7 标题为「🧠 英语助手」。
 *  4. 设置开关：autoTranslate 默认 OFF 且有侧栏开关。
 *
 * 注意：本文件只做静态存在性 + 一致性断言，不启动浏览器；行为联动由人工/集成测覆盖。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKBENCH_PATH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const INDEX_PATH = path.join(ROOT, 'index.html');
const HTML = fs.readFileSync(WORKBENCH_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');

describe('字节级一致铁律（workbench.html === index.html）', () => {
  test('两文件字节完全相同', () => {
    assert.equal(HTML, INDEX_HTML, 'index.html 必须与 workbench.html 字节级一致（改动后请 cp workbench.html index.html）');
  });
});

describe('查词 / 翻译 基础设施', () => {
  const tokens = [
    'const DictLoader',
    'lookupWord(word)',
    'function showDictPop',
    'function closeDictPop',
    'function translateSelection',
    'function showTrPop',
    'function closeTrPop',
    'const TranslateService',
    'function firstSelectedWord',
    'async callTranslate',
  ];
  for (const t of tokens) {
    test(`存在：${t}`, () => {
      assert.ok(HTML.includes(t), `workbench.html 缺少必要实现片段：${t}`);
    });
  }
  test('选中工具栏含 🔍查词 / 🌐翻译 两按钮', () => {
    assert.ok(HTML.includes('🔍 查词'), '缺少查词按钮');
    assert.ok(HTML.includes('🌐 翻译'), '缺少翻译按钮');
  });
});

describe('模块收起 + 英语助手更名', () => {
  test('首页 hub 具「更多」折叠入口', () => {
    assert.ok(HTML.includes('id="cogMoreBtn"'), '缺少 cogMoreBtn 折叠入口');
    assert.ok(HTML.includes('id="cogMoreList"'), '缺少 cogMoreList 折叠列表');
  });
  test('首页常驻「英语助手」入口（指向屏7）', () => {
    assert.ok(HTML.includes('🧠 英语助手'), '首页缺少「英语助手」常驻入口');
  });
  test('屏7 标题已更名「🧠 英语助手」', () => {
    assert.ok(HTML.includes('🧠 英语助手'), '屏7 标题未更名');
    assert.ok(!HTML.includes('🇬🇧 英语表达'), '屏7 旧标题「🇬🇧 英语表达」应已移除');
  });
});

describe('自动翻译设置开关', () => {
  test('settings 对象默认 autoTranslate=false', () => {
    assert.ok(HTML.includes('autoTranslate: false'), 'settings 默认应为 autoTranslate:false');
  });
  test('侧栏存在自动翻译开关', () => {
    assert.ok(HTML.includes('id="autoTrBtn"'), '缺少自动翻译开关按钮');
    assert.ok(HTML.includes('id="autoTrState"'), '缺少自动翻译状态徽标');
  });
  test('pushSync 同步 autoTranslate 字段', () => {
    assert.ok(HTML.includes('autoTranslate: !!Settings.get("autoTranslate")'), 'pushSync 未带上 autoTranslate');
  });
});
