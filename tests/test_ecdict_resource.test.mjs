/**
 * 聚焦回归：本地词典资源（生产真实加载路径）
 *
 * 背景：行为测试（test_cog_english_behavior.test.mjs）直接注入 window.ECDICT 桩，
 * 即便 vendor/ecdict.min.js / 分片缺失也会通过——这是真实的回归盲区。本文件补齐：
 *  - vendor/ecdict.min.js 现在是「空引导」（window.ECDICT = window.ECDICT || {}），
 *    只负责在首次查词时建立全局对象，真正词条由各首字母分片按需注入；
 *  - vendor/ecdict/ 下存在 a.js … z.js 共 26 个首字母分片（'#' 类词 _.js 允许缺失）；
 *  - 抽查某分片文件，确认其包含预期词条 JSON 且形态为 {phonetic,pos,meaning}。
 *
 * 说明：分片由 scripts/gen-ecdict-shards.mjs 从完整 ECDICT CSV 生成，约 70 万+ 词条。
 * 本测试只校验资源形态，不校验全部词条（由浏览器离线查词实测覆盖）。
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_PATH = path.join(ROOT, 'vendor/ecdict.min.js');
const SHARD_DIR = path.join(ROOT, 'vendor/ecdict');
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');

let bootstrapECDICT = null; // 加载引导后 window.ECDICT
let bootstrapSrc = '';

before(() => {
  bootstrapSrc = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
  const sandbox = { window: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(bootstrapSrc, sandbox, { filename: 'ecdict.min.js' });
  bootstrapECDICT = sandbox.window.ECDICT;
});

describe('vendor/ecdict.min.js 是空引导', () => {
  test('文件内容等价于 window.ECDICT = window.ECDICT || {}', () => {
    const normalized = bootstrapSrc.replace(/\s+/g, ' ').trim();
    assert.ok(
      normalized.includes('window.ECDICT = window.ECDICT || {}') ||
        normalized.includes('window.ECDICT=window.ECDICT||{}'),
      '引导文件应为 window.ECDICT = window.ECDICT || {}'
    );
  });

  test('加载后 window.ECDICT 为存在的空对象（全局先建立，词条待分片注入）', () => {
    assert.ok(bootstrapECDICT && typeof bootstrapECDICT === 'object', 'window.ECDICT 应存在且为对象');
    assert.equal(Object.keys(bootstrapECDICT).length, 0, '引导不应自带词条');
  });
});

describe('vendor/ecdict/ 首字母分片齐备', () => {
  test('a.js … z.js（26 个）全部存在', () => {
    const missing = [];
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      const p = path.join(SHARD_DIR, `${letter}.js`);
      if (!fs.existsSync(p)) missing.push(`${letter}.js`);
    }
    assert.equal(missing.length, 0, `缺少分片文件：${missing.join(', ')}`);
  });

  test("'#' 类分片 _.js 允许缺失（本词表无纯符号词则无需生成）", () => {
    const under = path.join(SHARD_DIR, '_.js');
    // 不强制存在：存在则校验合法，缺失也视为通过
    if (fs.existsSync(under)) {
      const src = fs.readFileSync(under, 'utf8');
      assert.ok(src.includes('window.ECDICT'), '_.js 应注入到 window.ECDICT');
    }
  });
});

describe('分片文件含预期词条 JSON', () => {
  function loadShard(letter) {
    const src = fs.readFileSync(path.join(SHARD_DIR, `${letter}.js`), 'utf8');
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: `${letter}.js` });
    return sandbox.window.ECDICT;
  }

  test('t.js 含常见词 the，且形态为 {phonetic,pos,meaning}', () => {
    const E = loadShard('t');
    assert.ok(E && E.the, 't.js 应包含 the');
    for (const f of ['phonetic', 'pos', 'meaning']) {
      assert.ok(f in E.the, `词条 the 缺少字段 ${f}`);
    }
    assert.ok(typeof E.the.meaning === 'string' && E.the.meaning.length > 0, 'the.meaning 应为非空字符串');
  });

  test('a.js 含 ability（已确认存在于分片头部）', () => {
    const E = loadShard('a');
    assert.ok(E && E.ability, 'a.js 应包含 ability');
    assert.ok(typeof E.ability.meaning === 'string' && E.ability.meaning.length > 0, 'ability.meaning 应为非空字符串');
  });

  test('所有分片键符合「小写纯字母」约定（与前端 normalizeWord 一致）', () => {
    // 抽样 a/t/z 三个分片即可覆盖规模与边界
    for (const letter of ['a', 't', 'z']) {
      const E = loadShard(letter);
      const bad = Object.keys(E).filter((k) => !/^[a-z]+$/.test(k));
      assert.equal(bad.length, 0, `${letter}.js 存在不符合约定的键：${bad.slice(0, 5).join(', ')}`);
    }
  });
});
