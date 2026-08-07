/**
 * 需求 B：GitHub 搜索重做为「按功能语义匹配」—— 独立验证测试
 *
 * 前端部分（与 pdf-* 系列一致）：从 workbench.html 按标记抽取真实源码，
 * 丢进 vm 沙箱真跑 parseIntent / buildGhQueries / mergeLanes / rankP0 / toCandidate /
 * rerankAsync（含 ghReqSeq 竞态守卫）。
 *
 * 后端部分：起临时 server.py 实例（PORT 随机、DATA_DIR 临时目录），用 fetch 打
 * POST /api/search/rerank，验证五条铁律：任何路径 200、无 key 降级、坏参 bad_request、
 * SSRF 白名单、candidates 清洗、限流 11 次。测完 kill 进程 + 删临时目录。
 *
 * 覆盖：
 *   A 静态不变量（前后端 sort=stars 清零 / VERSION 1.2.0 / 零第三方包 / SSRF 常量 / 竞态守卫 / 双文件一致）
 *   B L0 parseIntent（中文功能句 / 掩码消歧 / 语言识别 / 拉丁兜底 / unresolved / 词典 ≥200）
 *   C L1 buildGhQueries（core 严格前 2 词 / 无 token 单路 / 有 token 多路 / 语言限定）
 *   D L1 mergeLanes + rankP0（去重 / 多路优先 / 不引入 stars 加权 / 同分按 full_name）
 *   E L2 toCandidate（只传元数据，不传 README）
 *   F L2 rerankAsync 竞态：旧响应整包丢弃；正常路径原地重排
 *   G 后端 /api/search/rerank 冒烟（临时实例 + mini LLM 端点）
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// QA_TARGET_HTML 用于变异测试
const WORKBENCH = process.env.QA_TARGET_HTML || path.join(ROOT, 'workbench.html');
const INDEX = path.join(ROOT, 'index.html');
const HTML = fs.readFileSync(WORKBENCH, 'utf8');
const SERVER_PY = path.join(ROOT, 'server.py');

/* ══════════════════════════ 源码抽取 ══════════════════════════ */

function sliceBetween(src, startMarker, endMarker, label) {
  const a = src.indexOf(startMarker);
  assert.notEqual(a, -1, `抽取失败：找不到起始标记 ${label} → ${startMarker}`);
  const b = src.indexOf(endMarker, a + startMarker.length);
  assert.notEqual(b, -1, `抽取失败：找不到结束标记 ${label} → ${endMarker}`);
  return src.slice(a, b);
}

/** L0 意图解析整段：GH_STOP_* / GH_WEAK / GH_DICT / GH_TERMS / GH_LANG / parseIntent / buildGhQueries / ghHasToken / llmReady */
const R_INTENT = sliceBetween(
  HTML, 'const GH_STOP_CN = new Set(', '$("#ghSearch").onclick = doGhSearch;', 'intent');
/** mergeLanes + rankP0 */
const R_MERGE = sliceBetween(
  HTML, 'function mergeLanes(laneResults){', 'function renderGhIntent(it){', 'merge');
/** toCandidate */
const R_CANDIDATE = sliceBetween(
  HTML, 'function toCandidate(e){', '/* L2：LLM 语义重排', 'candidate');
/** rerankAsync + applyRerank + ghReqSeq */
const R_RERANK = sliceBetween(
  HTML, 'async function rerankAsync(query, list, seq){', 'async function doGhSearch(useCur){', 'rerank');
/** doGhSearch 主流程（竞态令牌递增） */
const R_DOSEARCH = sliceBetween(
  HTML, 'async function doGhSearch(useCur){', '/* ============ 认知资产', 'doGhSearch');
/** ghFetch */
const R_GHFETCH = sliceBetween(
  HTML, 'async function ghFetch(q, token, signal){', '/* 多路召回', 'ghFetch');

// 抽取边界自检
assert.ok(R_INTENT.includes('function parseIntent(text){'), '意图区块缺少 parseIntent');
assert.ok(R_INTENT.includes('function buildGhQueries(it, hasToken){'), '意图区块缺少 buildGhQueries');
assert.ok(R_MERGE.includes('function rankP0(list){'), '合并区块缺少 rankP0');
assert.ok(R_RERANK.includes('let ghReqSeq = 0;'), 'rerank 区块缺少 ghReqSeq 声明');
assert.ok(R_DOSEARCH.includes('const seq = ++ghReqSeq'), 'doGhSearch 缺少竞态令牌递增');

/* ══════════════════════════ vm 沙箱 ══════════════════════════ */

/** 纯函数沙箱：跑指定源码区块 + __api.get/set */
function makeSandboxPure(region) {
  const sandbox = {
    console, Math, JSON, Object, Array, String, Number, Set, Map, Promise, Error,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const epilogue = `globalThis.__api = { get: (k)=>eval(k), set: (k,v)=>{ eval(k + ' = v'); } };`;
  vm.runInContext(region + '\n' + epilogue, sandbox, { filename: 'pure.js' });
  return { sandbox, api: sandbox.__api };
}

function makeIntentSandbox() {
  return makeSandboxPure(R_INTENT);
}

/** rerank 沙箱：fetch / AbortController / renderGhList / ghDegradeBar 全部可观测 */
function makeRerankSandbox() {
  const calls = { renderGhList: [], degradeBar: [], barHide: 0 };
  const sandbox = {
    console, Math, JSON, Object, Array, String, Number, Set, Map, Promise, Error,
    setTimeout: () => 1, clearTimeout: () => {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => { throw new Error('fetch 未在测试中 stub'); },
    // R_RERANK 区块只含 rerankAsync/applyRerank/ghReqSeq，toCandidate 在区块外；
    // 真实 toCandidate 由 E 套件单独验证，这里用最小映射 stub 避免 ReferenceError
    toCandidate: (e) => ({ full_name: e.repo.full_name }),
    renderGhList: (list, stage) => calls.renderGhList.push({ list, stage }),
    ghDegradeBar: (reason) => calls.degradeBar.push(reason),
    $: (sel) => ({ style: { display: '' }, innerHTML: '' }),
    __calls: calls,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const epilogue = `globalThis.__api = { get: (k)=>eval(k), set: (k,v)=>{ eval(k + ' = v'); } };`;
  vm.runInContext(R_RERANK + '\n' + epilogue, sandbox, { filename: 'rerank.js' });
  return { sandbox, api: sandbox.__api, calls };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const plain = (v) => JSON.parse(JSON.stringify(v));

/* ══════════════════════════ A. 静态不变量 ══════════════════════════ */

describe('A. 静态不变量（前后端）', () => {
  test('A1 前端无 sort=stars 硬编码', () => {
    assert.equal((HTML.match(/sort=stars/g) || []).length, 0, 'workbench.html 仍存在 sort=stars');
  });

  test('A2 ghFetch 不拼 sort，per_page=50', () => {
    assert.ok(!/sort/.test(R_GHFETCH), 'ghFetch 不得携带 sort 参数');
    assert.match(R_GHFETCH, /per_page=50/, 'ghFetch 应使用 per_page=50');
  });

  test('A3 server.py：VERSION 1.2.0 + 独立 rerank 限流（10/min，不共用 90/min）', () => {
    const sv = fs.readFileSync(SERVER_PY, 'utf8');
    assert.match(sv, /VERSION = "1\.2\.0"/, 'VERSION 未升到 1.2.0');
    assert.match(sv, /rerank_limiter = RateLimiter\(10, 60\)/, '缺少独立 rerank 限流器');
    assert.match(sv, /github_limiter = RateLimiter\(90, 60\)/, 'github_limiter 配置异常');
  });

  test('A4 server.py 零第三方包（无 requests/openai/httpx/aiohttp）', () => {
    const sv = fs.readFileSync(SERVER_PY, 'utf8');
    assert.ok(!/^\s*import (requests|openai|httpx|aiohttp)/m.test(sv), 'server.py 引入了第三方包');
  });

  test('A5 server.py github 路由：sort 白名单 + per_page clamp [1,100]', () => {
    const sv = fs.readFileSync(SERVER_PY, 'utf8');
    assert.match(sv, /max\(1, min\(100, pp\)\)/, 'per_page 未 clamp 到 [1,100]');
    assert.match(sv, /sort in \("stars", "forks", "help-wanted-issues", "updated"\)/, 'sort 白名单缺失');
  });

  test('A6 SSRF 防护：LLM_ALLOWED_BASES 白名单 + 模型名消毒正则', () => {
    const sv = fs.readFileSync(SERVER_PY, 'utf8');
    assert.match(sv, /LLM_ALLOWED_BASES/, '缺少 LLM_ALLOWED_BASES');
    assert.match(sv, /_MODEL_RE = re\.compile\(r"\^\[A-Za-z0-9\._:\/-\]\{1,64\}\$"\)/, '缺少模型名消毒正则');
  });

  test('A7 竞态守卫：rerankAsync/applyRerank 带 seq 比对；doGhSearch 递增令牌且多处检查', () => {
    assert.match(R_RERANK, /if\(seq !== ghReqSeq\) return/, 'rerankAsync/applyRerank 缺少竞态守卫');
    assert.match(R_DOSEARCH, /const seq = \+\+ghReqSeq/, 'doGhSearch 未递增竞态令牌');
    const guards = R_DOSEARCH.match(/seq !== ghReqSeq/g) || [];
    assert.ok(guards.length >= 2, `doGhSearch 竞态检查点不足（${guards.length}）`);
  });

  test('A8 buildGhQueries 彻底放弃 OR / 括号组合语法', () => {
    const src = sliceBetween(HTML, 'function buildGhQueries(it, hasToken){', 'function relaxIntent(it){', 'buildGhQueries');
    assert.ok(!src.includes(' OR '), '不得出现 OR 语法');
    assert.ok(!/\(\s*[^)]*\bOR\b/.test(src), '不得出现括号 OR 组合');
  });

  test('A9 .env.example 补齐 LLM 配置段', () => {
    const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const k of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_TIMEOUT', 'LLM_PROXY', 'LLM_ALLOWED_BASES']) {
      assert.ok(env.includes(k), `.env.example 缺少 ${k}`);
    }
  });

  test('A10 index.html 与 workbench.html 字节级一致', () => {
    assert.ok(fs.readFileSync(WORKBENCH).equals(fs.readFileSync(INDEX)), 'index.html 未同步');
  });

  test('A11 wbCfg 只在函数体内读取（防 TDZ）', () => {
    const ghRange = sliceBetween(HTML, '/* ============ GitHub 探索', '/* ============ 认知资产', 'ghRange');
    const lines = ghRange.split('\n').filter((l) => l.includes('wbCfg.'));
    assert.ok(lines.length >= 2, '未找到 wbCfg 属性读取点（实现漂移？）');
    for (const l of lines) {
      assert.ok(/^\s{2,}/.test(l), `wbCfg 疑似在模块顶层读取（TDZ 风险）: ${l.trim()}`);
    }
  });
});

/* ══════════════════════════ B. L0 parseIntent ══════════════════════════ */

describe('B. L0 parseIntent 意图解析', () => {
  test('B1 中文功能句 → 提取 core 关键词 + topic', () => {
    const s = makeIntentSandbox();
    const it = plain(s.api.get('parseIntent("找一个管理每日待办的轻量工具")'));
    assert.equal(it.unresolved, false);
    assert.ok(it.keywords.includes('todo'), `keywords 应含 todo，实际 ${JSON.stringify(it.keywords)}`);
    assert.ok(it.keywords.includes('task'));
    assert.ok(it.topics.includes('todo-list'));
    assert.equal(it.archivedFalse, true);
  });

  test('B2 掩码消歧：「记账本」命中后不再触发「记账」', () => {
    const s = makeIntentSandbox();
    const it = plain(s.api.get('parseIntent("好用的记账本")'));
    assert.equal(it.unresolved, false);
    assert.ok(it.keywords.includes('expense'));
    assert.ok(it.keywords.includes('ledger'));
    assert.equal(it.keywords.filter((k) => k === 'expense').length, 1, 'expense 被重复命中 → 掩码失效');
  });

  test('B3 语言识别：python → Python，keywords 含 crawler，topic web-scraping', () => {
    const s = makeIntentSandbox();
    const it = plain(s.api.get('parseIntent("我想找个用python写的爬虫")'));
    assert.equal(it.language, 'Python');
    assert.ok(it.keywords.includes('crawler'));
    assert.ok(it.topics.includes('web-scraping'));
  });

  test('B4 拉丁 token 兜底：飞书同步到 notion → keywords 含 notion', () => {
    const s = makeIntentSandbox();
    const it = plain(s.api.get('parseIntent("帮我找个把飞书文档同步到notion的东西")'));
    assert.equal(it.unresolved, false);
    assert.ok(it.keywords.includes('notion'));
  });

  test('B5 完全无关键词 → unresolved=true 且 keywords 为空', () => {
    const s = makeIntentSandbox();
    const it = plain(s.api.get('parseIntent("这个东西挺好的")'));
    assert.equal(it.unresolved, true);
    assert.deepEqual(it.keywords, []);
  });

  test('B6 英文输入：todo list app → 词典强词 todo/task 命中且不占首位的是弱词', () => {
    const s = makeIntentSandbox();
    const it = plain(s.api.get('parseIntent("todo list app")'));
    assert.equal(it.unresolved, false);
    assert.ok(it.keywords.includes('todo'), `keywords 应含 todo，实际 ${JSON.stringify(it.keywords)}`);
    assert.ok(it.keywords.includes('task'), `keywords 应含 task（词典同义词），实际 ${JSON.stringify(it.keywords)}`);
    assert.equal(it.keywords[0], 'todo', '词典强命中词应排在拉丁/弱词之前');
  });

  test('B7 词典展开 ≥ 200 组', () => {
    const s = makeIntentSandbox();
    const n = s.api.get('GH_TERMS.length');
    assert.ok(n >= 200, `GH_DICT 展开后应 ≥ 200 组，实际 ${n}`);
  });
});

/* ══════════════════════════ C. L1 buildGhQueries ══════════════════════════ */

describe('C. L1 buildGhQueries：core 前 2 词 + AND 语义 + 路数控制', () => {
  function intent(keywords, topics = [], language = null) {
    return { raw: 'x', keywords, topics, language, archivedFalse: true, unresolved: false, dropped: [] };
  }

  test('C1 无 token：单路 all + in:name,description,readme + archived:false；core 严格前 2 词', () => {
    const s = makeIntentSandbox();
    const it = intent(['todo', 'task', 'reminder']);
    const lanes = plain(s.api.get(`buildGhQueries(${JSON.stringify(it)}, false)`));
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].lane, 'all');
    assert.match(lanes[0].q, /in:name,description,readme/);
    assert.match(lanes[0].q, /archived:false/);
    assert.ok(lanes[0].q.startsWith('todo task'), 'core 应为前两个关键词（AND 语义）');
    assert.ok(!lanes[0].q.includes('reminder'), '第 3 词不得进入自由词（词越多召回越少）');
  });

  test('C2 有 token：2~3 路召回，每路 core ≤ 2 词', () => {
    const s = makeIntentSandbox();
    const it = intent(['todo', 'task', 'reminder'], ['todo-list']);
    const lanes = plain(s.api.get(`buildGhQueries(${JSON.stringify(it)}, true)`));
    assert.ok(lanes.length >= 2 && lanes.length <= 3, `有 token 应为 2~3 路，实际 ${lanes.length}`);
    const name = lanes.find((l) => l.lane === 'name');
    const readme = lanes.find((l) => l.lane === 'readme');
    assert.ok(name && name.q.includes('in:name,description'), '缺 name/desc 路');
    assert.ok(readme && readme.q.includes('in:readme'), '缺 readme 路');
    assert.ok(name.q.startsWith('todo task'), 'name 路 core 必须前 2 词');
    assert.ok(!readme.q.includes('reminder'), 'readme 路不得带入第 3 词');
    const topic = lanes.find((l) => l.lane === 'topic');
    assert.ok(topic, '有 topics 时应生成 topic 路');
    assert.match(topic.q, /^topic:todo-list/, 'topic 路应以 topic: 开头');
  });

  test('C3 无 topics 时不生成 topic 路（避免白烧配额）', () => {
    const s = makeIntentSandbox();
    const it = intent(['todo', 'task'], []);
    const lanes = plain(s.api.get(`buildGhQueries(${JSON.stringify(it)}, true)`));
    assert.ok(!lanes.some((l) => l.lane === 'topic'), '无 topics 时不得生成 topic 路');
    assert.equal(lanes.length, 2);
  });

  test('C4 语言限定拼进查询', () => {
    const s = makeIntentSandbox();
    const it = intent(['crawler'], [], 'Python');
    const lanes = plain(s.api.get(`buildGhQueries(${JSON.stringify(it)}, false)`));
    assert.match(lanes[0].q, /language:Python/);
  });
});

/* ══════════════════════════ D. mergeLanes / rankP0 ══════════════════════════ */

describe('D. L1 mergeLanes + rankP0：确定性排序，不引入 stars 加权', () => {
  function repo(full_name, stars) {
    return { full_name, stargazers_count: stars, html_url: 'https://x/' + full_name, description: 'd', language: 'Go', forks_count: 0, pushed_at: '', topics: [] };
  }

  test('D1 mergeLanes：按 full_name 去重，记录多路命中与最佳位次', () => {
    const s = makeSandboxPure(R_MERGE);
    const laneResults = [
      { lane: 'name', badge: '🔎 关键词命中', items: [repo('a/x'), repo('b/y')] },
      { lane: 'readme', badge: '📄 README 命中', items: [repo('a/x'), repo('c/z')] },
    ];
    const merged = plain(s.api.get(`mergeLanes(${JSON.stringify(laneResults)})`));
    assert.equal(merged.length, 3, '应按 full_name 去重');
    const a = merged.find((m) => m.repo.full_name === 'a/x');
    assert.deepEqual(a.lanes, ['name', 'readme']);
    assert.deepEqual(a.badges, ['🔎 关键词命中', '📄 README 命中']);
    assert.equal(a.bestRank, 0, 'bestRank 应取各命中路中的最前位次');
    const b = merged.find((m) => m.repo.full_name === 'b/y');
    assert.equal(b.bestRank, 1);
  });

  test('D2 rankP0：多路命中优先（即使 stars 少）；同分按 full_name 稳定兜底', () => {
    const s = makeSandboxPure(R_MERGE);
    const list = [
      { repo: repo('zzz/highstars', 99999), lanes: ['name'], bestRank: 1 },
      { repo: repo('aaa/multilane', 1), lanes: ['name', 'readme'], bestRank: 50 },
      { repo: repo('mmm/same', 5), lanes: ['name'], bestRank: 0 },
    ];
    const out = plain(s.api.get(`rankP0(${JSON.stringify(list)})`));
    assert.equal(out[0].repo.full_name, 'aaa/multilane', '多路命中必须排最前，star 少也不得被压下去');
    assert.equal(out[0].p0score, 2 * 1000 - 50, 'p0score = lanes.length*1000 - bestRank');
    assert.equal(out[1].repo.full_name, 'mmm/same', '同路数按 bestRank 升序（尊重 best-match 位次）');
    assert.equal(out[2].repo.full_name, 'zzz/highstars', '同分时按 full_name 字典序兜底');
  });

  test('D3 rankP0 排序稳定可复现（两次调用结果一致）', () => {
    const s = makeSandboxPure(R_MERGE);
    const list = [
      { repo: repo('b/one', 10), lanes: ['name'], bestRank: 0 },
      { repo: repo('a/two', 20), lanes: ['name', 'readme'], bestRank: 3 },
      { repo: repo('c/three', 30), lanes: ['name'], bestRank: 1 },
    ];
    const once = plain(s.api.get(`rankP0(${JSON.stringify(list)})`)).map((e) => e.repo.full_name);
    const twice = plain(s.api.get(`rankP0(${JSON.stringify(list)})`)).map((e) => e.repo.full_name);
    assert.deepEqual(twice, once);
  });
});

/* ══════════════════════════ E. toCandidate ══════════════════════════ */

describe('E. L2 toCandidate：只传元数据，不传 README', () => {
  test('E1 字段映射 + desc/topics 截断 + 不含 README', () => {
    const s = makeSandboxPure(R_CANDIDATE);
    const repoObj = {
      full_name: 'a/b',
      description: 'x'.repeat(300),
      topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7'],
      language: 'Go',
      stargazers_count: 1234,
      pushed_at: '2026-07-01T00:00:00Z',
      readme: 'SECRET_README_BODY',
    };
    // toCandidate 的入参是 { repo, ... }（RankedRepo 结构），不是裸 repo
    const c = plain(s.api.get(`toCandidate(${JSON.stringify({ repo: repoObj })})`));
    assert.equal(c.description.length, 200, 'description 应截断 200');
    assert.equal(c.topics.length, 6, 'topics 应截断 6');
    assert.equal(c.stars, 1234);
    assert.equal(c.pushed_at, '2026-07-01T00:00:00Z');
    assert.ok(!('readme' in c), 'toCandidate 不得带 README 正文');
    assert.ok(!JSON.stringify(c).includes('SECRET_README_BODY'), 'README 内容泄漏');
  });
});

/* ══════════════════════════ F. rerankAsync 竞态 ══════════════════════════ */

describe('F. L2 rerankAsync：ghReqSeq 竞态守卫 + 原地重排', () => {
  function sampleList() {
    return [
      { repo: { full_name: 'b/y' }, p0score: 800 },
      { repo: { full_name: 'a/x' }, p0score: 900 },
      { repo: { full_name: 'c/z' }, p0score: 700 },
    ];
  }

  test('F1 旧响应（seq 过期）整包丢弃：不渲染、不降级提示', async () => {
    const env = makeRerankSandbox();
    const d = deferred();
    env.sandbox.fetch = async () => d.promise;
    env.api.set('ghReqSeq', 1);
    const p = env.api.get(`rerankAsync("q", ${JSON.stringify(sampleList())}, 1)`);
    // 用户已发起新搜索 → 令牌递增
    env.api.set('ghReqSeq', 2);
    d.resolve({ ok: true, status: 200, json: async () => ({ ok: true, fallback: false, ranked: [{ full_name: 'a/x', score: 99, reason: 'x' }] }) });
    await p;
    assert.equal(env.calls.renderGhList.length, 0, '过期响应不得渲染（会覆盖新结果）');
    assert.equal(env.calls.degradeBar.length, 0, '过期响应不得触发降级提示');
  });

  test('F2 正常路径：seq 匹配 → 原地重排 + llmScore/llmReason 写入，未覆盖项按 p0score 接后', async () => {
    const env = makeRerankSandbox();
    const d = deferred();
    env.sandbox.fetch = async () => d.promise;
    env.api.set('ghReqSeq', 1);
    const p = env.api.get(`rerankAsync("q", ${JSON.stringify(sampleList())}, 1)`);
    d.resolve({
      ok: true, status: 200,
      json: async () => ({ ok: true, fallback: false, ranked: [
        { full_name: 'a/x', score: 60, reason: 'r1' },
        { full_name: 'b/y', score: 90, reason: 'r2' },
      ] }),
    });
    await p;
    assert.equal(env.calls.renderGhList.length, 1);
    const { list: out, stage } = env.calls.renderGhList[0];
    assert.equal(stage, 'llm');
    // out 是 vm realm 对象，deepEqual 前归一化
    assert.deepEqual(plain(out.map((e) => e.repo.full_name)), ['b/y', 'a/x', 'c/z'], '应按 LLM score 降序，未覆盖项接后');
    assert.equal(out[0].llmScore, 90);
    assert.equal(out[0].llmReason, 'r2');
    assert.equal(out[1].llmScore, 60);
    assert.equal(out[2].llmScore, undefined, '未覆盖项无 llmScore');
  });

  test('F3 前端 8s AbortController：超时后降级提示（timeout）且保留 L1 结果', async () => {
    const env = makeRerankSandbox();
    // fetch 抛 AbortError（模拟 AbortController 超时）
    env.sandbox.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    env.api.set('ghReqSeq', 1);
    await env.api.get(`rerankAsync("q", ${JSON.stringify(sampleList())}, 1)`);
    assert.equal(env.calls.renderGhList.length, 0, '超时不得重排（保留 L1 结果）');
    assert.deepEqual(env.calls.degradeBar, ['timeout'], '超时应触发 timeout 降级提示');
  });

  test('F4 降级路径：ok:false → ghDegradeBar(reason)，不渲染', async () => {
    const env = makeRerankSandbox();
    const d = deferred();
    env.sandbox.fetch = async () => d.promise;
    env.api.set('ghReqSeq', 1);
    const p = env.api.get(`rerankAsync("q", ${JSON.stringify(sampleList())}, 1)`);
    d.resolve({ ok: true, status: 200, json: async () => ({ ok: false, fallback: true, reason: 'rate_limited' }) });
    await p;
    assert.equal(env.calls.renderGhList.length, 0);
    assert.deepEqual(env.calls.degradeBar, ['rate_limited']);
  });
});

/* ══════════════════════════ G. 后端 /api/search/rerank 冒烟 ══════════════════════════ */

function findPython() {
  for (const c of ['python', 'python3', 'py']) {
    const r = spawnSync(c, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '3') return c;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 假 LLM 端点：OpenAI 兼容 /v1/chat/completions；记录收到的请求体；可脚本化响应 */
function startMiniLlm() {
  return new Promise((resolve, reject) => {
    const requests = [];
    let scripted = JSON.stringify([{ full_name: 'user/repo0', score: 88, reason: '默认理由' }]);
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (e) {}
        const userMsg = ((body.messages || []).find((m) => m.role === 'user') || {}).content || '';
        requests.push({ url: req.url, headers: req.headers, body, userMsg });
        if (userMsg.includes('FORCE_500')) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'upstream boom' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: scripted } }] }));
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      requests,
      setScripted: (s) => { scripted = s; },
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

function startServer(py, { env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(py, [SERVER_PY], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    const port = env.PORT;
    const deadline = Date.now() + 25000;
    const poll = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/config`);
        if (r.ok) { resolve({ proc, out: () => out }); return; }
      } catch (e) { /* 未就绪 */ }
      if (Date.now() > deadline) {
        try { proc.kill('SIGKILL'); } catch (e) {}
        reject(new Error(`server.py 启动超时（port ${port}）\n${out.slice(-2000)}`));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

function killServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    proc.once('exit', () => resolve());
    try { proc.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) {}
      resolve();
    }, 1200);
  });
}

async function postJson(port, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api/search/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}

const VALID_BODY = (n = 3) => ({
  query: '找一个管理每日待办的小工具',
  candidates: Array.from({ length: n }, (_, i) => ({
    full_name: `user/repo${i}`,
    description: 'desc ' + i,
    topics: ['todo'],
    language: 'Go',
    stars: 100 + i,
    pushed_at: '2026-07-01',
  })),
});

describe('G. 后端 /api/search/rerank 冒烟（临时 server.py 实例）', () => {
  const py = findPython();
  const canRun = !!py;
  const state = { servers: [], tmps: [], mini: null, portA: null, portB: null, portC: null };

  before(async () => {
    if (!canRun) return;
    const mini = await startMiniLlm();
    state.mini = mini;
    // Server A：无 LLM key（测降级/坏参）
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rerank-a-'));
    const portA = await getFreePort();
    state.portA = portA; state.tmps.push(tmpA);
    state.servers.push(await startServer(py, {
      env: { ...process.env, PORT: String(portA), DATA_DIR: tmpA, STORAGE_BACKEND: 'sqlite', BACKUP_INTERVAL: '0', LLM_API_KEY: '', LLM_TIMEOUT: '3' },
    }));
    // Server B：有 LLM key → 打到 mini 端点（测 SSRF / 清洗 / 正常路径）
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rerank-b-'));
    const portB = await getFreePort();
    state.portB = portB; state.tmps.push(tmpB);
    state.servers.push(await startServer(py, {
      env: {
        ...process.env, PORT: String(portB), DATA_DIR: tmpB, STORAGE_BACKEND: 'sqlite', BACKUP_INTERVAL: '0',
        LLM_API_KEY: 'test-key-123',
        LLM_BASE_URL: `http://127.0.0.1:${mini.port}/v1`,
        LLM_ALLOWED_BASES: `http://127.0.0.1:${mini.port}/v1`,
        LLM_MODEL: 'deepseek-chat',
        LLM_TIMEOUT: '3',
      },
    }));
    // Server C：无 key（测限流，独立进程保证限流计数干净）
    const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rerank-c-'));
    const portC = await getFreePort();
    state.portC = portC; state.tmps.push(tmpC);
    state.servers.push(await startServer(py, {
      env: { ...process.env, PORT: String(portC), DATA_DIR: tmpC, STORAGE_BACKEND: 'sqlite', BACKUP_INTERVAL: '0', LLM_API_KEY: '', LLM_TIMEOUT: '3' },
    }));
  });

  after(async () => {
    for (const s of state.servers) await killServer(s.proc);
    if (state.mini) await state.mini.close();
    for (const t of state.tmps) { try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {} }
  });

  test('G1 无 key → 200 + llm_not_configured（绝不是 5xx）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const { status, j } = await postJson(state.portA, VALID_BODY(1));
    assert.equal(status, 200, `无 key 必须 200，实际 ${status}`);
    assert.equal(j.ok, false);
    assert.equal(j.fallback, true);
    assert.equal(j.reason, 'llm_not_configured');
  });

  test('G2 空参 / 坏参 → 200 + bad_request（不是 400/5xx）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    // 无 key 服务器：query 为空 / candidates 非数组或空数组 → bad_request（key 检查在这些结构性坏参之后）
    const cases = [
      {},
      { query: '' },
      { query: 'x' },
      { query: 'x', candidates: [] },
      { query: 'x', candidates: 'not-array' },
    ];
    for (const body of cases) {
      const { status, j } = await postJson(state.portA, body);
      assert.equal(status, 200, `坏参必须 200: ${JSON.stringify(body)}`);
      assert.equal(j.reason, 'bad_request', `应为 bad_request: ${JSON.stringify(body)}`);
    }
  });

  test('G2b candidates 清洗后为空（全无 full_name）→ 200 + bad_request（有 key 时走到净化层）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const { status, j } = await postJson(state.portB, { query: 'x', candidates: [{}] });
    assert.equal(status, 200);
    assert.equal(j.reason, 'bad_request');
  });

  test('G3 SSRF 白名单：X-LLM-Base 指向元数据 IP 被忽略，仍打默认 base', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const mini = state.mini;
    const before = mini.requests.length;
    // 控制组：不带 X-LLM-Base → 走默认 base（mini）
    await postJson(state.portB, VALID_BODY(1));
    // 攻击组：X-LLM-Base 指向 169.254.169.254 → 必须被忽略
    const { status, j } = await postJson(state.portB, VALID_BODY(1), { 'X-LLM-Base': 'http://169.254.169.254/' });
    assert.equal(status, 200);
    // 若头被采用（SSRF 漏洞），这两次请求都不会到达 mini → 断言失败
    assert.ok(mini.requests.length >= before + 2,
      `SSRF 头未生效时请求应到达默认 base；实际 mini 仅收到 ${mini.requests.length - before} 个新请求`);
    assert.ok(j.ok === true || j.reason, '攻击组也应得到正常响应');
  });

  test('G4 candidates 清洗：desc≤200 / topics≤6 / N≤25 / 绝不传 README', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const mini = state.mini;
    const before = mini.requests.length;
    const longDesc = 'x'.repeat(500);
    const manyTopics = Array.from({ length: 20 }, (_, i) => 't' + i);
    const body = {
      query: '清洗测试',
      candidates: Array.from({ length: 30 }, (_, i) => ({
        full_name: `clean/repo${i}`,
        description: longDesc,
        topics: manyTopics,
        language: 'Go',
        stars: 5,
        pushed_at: '2026-07-01T00:00:00Z',
        readme: 'SECRET_README_BODY',
      })),
    };
    await postJson(state.portB, body);
    const last = mini.requests[mini.requests.length - 1];
    const m = last.userMsg.match(/候选仓库（JSON 数组）：\n(\[.*\])\n\n请为每个候选/);
    assert.ok(m, 'mini 收到的 user 消息里找不到候选 JSON');
    const cands = JSON.parse(m[1]);
    assert.ok(cands.length <= 25, `候选应截断到 25，实际 ${cands.length}`);
    for (const c of cands) {
      assert.ok(c.description.length <= 200, `description 未截断 200: ${c.full_name}`);
      assert.ok(c.topics.length <= 6, `topics 未截断 6: ${c.full_name}`);
      assert.ok(!('readme' in c), `候选不得包含 README 字段: ${c.full_name}`);
    }
    assert.ok(!last.userMsg.includes('SECRET_README_BODY'), 'README 正文泄漏进 LLM prompt');
  });

  test('G5 限流：连打 11 次 → 第 11 次 200 + rate_limited（不是 429）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const results = [];
    for (let i = 0; i < 11; i++) {
      const r = await postJson(state.portC, VALID_BODY(1));
      results.push(r);
    }
    for (let i = 0; i < 10; i++) {
      assert.equal(results[i].status, 200, `第 ${i + 1} 次应 200`);
      assert.equal(results[i].j.reason, 'llm_not_configured', `第 ${i + 1} 次应为无 key 降级`);
    }
    assert.equal(results[10].status, 200, '第 11 次必须 200，不得 429');
    assert.equal(results[10].j.reason, 'rate_limited');
    assert.equal(results[10].j.ok, false);
    assert.equal(results[10].j.fallback, true);
  });

  test('G6 正常路径：LLM 返回 → 200 ok:true；幻觉 full_name 丢弃、score clamp、reason 截断', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const mini = state.mini;
    mini.setScripted(JSON.stringify([
      { full_name: 'user/repo0', score: 150, reason: 'x'.repeat(100) },
      { full_name: 'ghost/notin', score: 99, reason: '幻觉仓库应被丢弃' },
    ]));
    const { status, j } = await postJson(state.portB, VALID_BODY(1));
    assert.equal(status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.fallback, false);
    assert.equal(j.model, 'deepseek-chat');
    assert.ok(Array.isArray(j.ranked));
    assert.equal(j.ranked.length, 1, '幻觉 full_name 必须被丢弃');
    assert.equal(j.ranked[0].full_name, 'user/repo0');
    assert.equal(j.ranked[0].score, 100, 'score 应 clamp 到 0-100');
    assert.ok(j.ranked[0].reason.length <= 40, 'reason 应截断 40 字');
    assert.ok(!j.ranked.some((r) => r.full_name === 'ghost/notin'));
  });

  test('G7 上游返回 markdown 代码块 → 仍能解析（extract_json_array）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const mini = state.mini;
    mini.setScripted('```json\n' + JSON.stringify([{ full_name: 'user/repo0', score: 88, reason: '代码块也能解析' }]) + '\n```');
    const { status, j } = await postJson(state.portB, VALID_BODY(1));
    assert.equal(status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.ranked.length, 1);
    assert.equal(j.ranked[0].full_name, 'user/repo0');
  });

  test('G8 上游 500 → 200 + upstream_error（绝不 5xx）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const { status, j } = await postJson(state.portB, { ...VALID_BODY(1), query: 'FORCE_500 触发上游错误' });
    assert.equal(status, 200, '上游 500 时本接口仍必须 200');
    assert.equal(j.ok, false);
    assert.equal(j.fallback, true);
    assert.equal(j.reason, 'upstream_error');
  });

  test('G9 X-LLM-Model 非法值被忽略（正则消毒）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const mini = state.mini;
    mini.setScripted(JSON.stringify([{ full_name: 'user/repo0', score: 50, reason: 'ok' }]));
    const { status, j } = await postJson(state.portB, VALID_BODY(1), { 'X-LLM-Model': 'bad model!!' });
    assert.equal(status, 200);
    assert.equal(j.model, 'deepseek-chat', '非法模型名应回落默认 LLM_MODEL');
  });

  test('G10 /api/config 暴露 llm_rerank 位（无 key=false / 有 key=true / byok=true）', async (t) => {
    if (!canRun) return t.skip('未找到 python3');
    const ca = await fetch(`http://127.0.0.1:${state.portA}/api/config`).then((r) => r.json());
    const cb = await fetch(`http://127.0.0.1:${state.portB}/api/config`).then((r) => r.json());
    assert.equal(ca.llm_rerank, false);
    assert.equal(cb.llm_rerank, true);
    assert.equal(cb.llm_rerank_byok, true);
    assert.equal(cb.llm_model, 'deepseek-chat');
  });
});
