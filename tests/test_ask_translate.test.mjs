/**
 * 后端翻译接口回归测试 —— functions/api/ai/ask.ts（task:"translate" 分支）
 *
 * 说明：本期翻译后端实现落在 Cloudflare Function（ask.ts），而非设计文档初版设想的
 * server.py /api/ai/translate（见 design-cog-english.md §3 与 T02 的偏差）。本测试针对
 * 真实实现，用 esbuild 把 ask.ts 打包成可在 Node 直跑的模块；requireUser 用桩替换
 * （仅保留「无 Bearer 即 401」的 fail-closed 语义，跳过真实 JWT/Supabase 校验）。
 *
 * 覆盖：鉴权门禁 / 空文本 / 未配置 key / 中英互译方向 / 成功映射 / 上游错误 / 解析失败 / 等级。
 */
import { test, describe, before, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASK = path.join(ROOT, 'functions/api/ai/ask.ts');

let onRequestPost;
let lastUpstream = null; // 记录发给 DeepSeek 的请求 {url, body}

function makeEnv(withKey) {
  return withKey
    ? { DEEPSEEK_API_KEY: 'k', AI_API_BASE: 'https://api.deepseek.com/v1', AI_MODEL: 'deepseek-chat' }
    : {};
}

function makeRequest(body, token = true) {
  return new Request('https://x/api/ai/ask', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer test-token' } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function callTranslate(body, env, token = true) {
  const req = makeRequest(body, token);
  const res = await onRequestPost({ request: req, env });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function setFetchImpl(impl) {
  globalThis.fetch = (...args) => impl(...args);
}

before(async () => {
  const stubPath = path.join(os.tmpdir(), `cog_auth_stub_${process.pid}.ts`);
  fs.writeFileSync(
    stubPath,
    `import { HttpError } from ${JSON.stringify(path.resolve(ROOT, 'lib/json.ts'))};\n` +
    `export async function requireUser(request, env) {\n` +
    `  const h = request.headers.get('Authorization') || '';\n` +
    `  if (!h.startsWith('Bearer ')) throw new HttpError(401, '未登录');\n` +
    `  return { uid: 'u1', username: 'tester' };\n` +
    `}\n`,
  );
  const plugin = {
    name: 'auth-stub',
    setup(b) {
      b.onResolve({ filter: /.*lib[\\/]auth\.ts$/ }, () => ({ path: stubPath }));
    },
  };
  const out = await esbuild.build({
    entryPoints: [ASK],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    absWorkingDir: ROOT,
    plugins: [plugin],
  });
  const tmp = path.join(os.tmpdir(), `cog_ask_bundle_${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  const mod = await import('file://' + tmp);
  onRequestPost = mod.onRequestPost;
});

beforeEach(() => {
  setFetchImpl(async (url, opts) => {
    lastUpstream = { url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'translated text' } }] }),
      { status: 200 },
    );
  });
});

afterEach(() => {
  lastUpstream = null;
});

describe('ask.ts translate 分支', () => {
  test('鉴权门禁：无 Bearer → 401', async () => {
    const { status } = await callTranslate({ task: 'translate', text: 'hi' }, makeEnv(true), false);
    assert.equal(status, 401);
  });

  test('空文本 → 400', async () => {
    const { status } = await callTranslate({ task: 'translate' }, makeEnv(true));
    assert.equal(status, 400);
  });

  test('未配置 LLM key → {ok:false, reason:"llm_not_configured"}', async () => {
    const { status, json } = await callTranslate({ task: 'translate', text: 'hi' }, makeEnv(false));
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.reason, 'llm_not_configured');
  });

  test('含 CJK → zh2en 方向，系统提示要求「中文翻译为英文」', async () => {
    const { status, json } = await callTranslate({ task: 'translate', text: '你好世界' }, makeEnv(true));
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.dir, 'zh2en');
    const sys = lastUpstream.body.messages[0].content;
    assert.ok(sys.includes('中文翻译'), 'zh2en 系统提示应要求把中文翻译成英文');
    assert.equal(json.translation, 'translated text');
  });

  test('纯英文 → en2zh 方向，系统提示要求「英文译为中文」', async () => {
    const { status, json } = await callTranslate({ task: 'translate', text: 'hello world' }, makeEnv(true));
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.dir, 'en2zh');
    const sys = lastUpstream.body.messages[0].content;
    assert.ok(sys.includes('英文') && sys.includes('中文'), 'en2zh 系统提示应要求把英文译成中文');
  });

  test('默认 level 为 cet4，系统提示用四级水准', async () => {
    const { json } = await callTranslate({ task: 'translate', text: '你好' }, makeEnv(true));
    const sys = lastUpstream.body.messages[0].content;
    assert.ok(sys.includes('CET-4') || sys.includes('四级'), '默认应走四级水准');
    assert.equal(json.level, 'cet4');
  });

  test('level=cet6 → 系统提示用六级水准，回显 level', async () => {
    const { json } = await callTranslate({ task: 'translate', text: '你好', level: 'cet6' }, makeEnv(true));
    const sys = lastUpstream.body.messages[0].content;
    assert.ok(sys.includes('CET-6') || sys.includes('六级'), 'cet6 应走六级水准');
    assert.equal(json.level, 'cet6');
  });

  test('上游 LLM 返回非 2xx → {ok:false, reason:"upstream_error"}', async () => {
    setFetchImpl(async () => new Response('boom', { status: 500 }));
    const { status, json } = await callTranslate({ task: 'translate', text: 'hi' }, makeEnv(true));
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.reason, 'upstream_error');
  });

  test('LLM 返回空译文 → {ok:false, reason:"parse_failed"}', async () => {
    setFetchImpl(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '' } }] }),
      { status: 200 },
    ));
    const { status, json } = await callTranslate({ task: 'translate', text: 'hi' }, makeEnv(true));
    assert.equal(status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.reason, 'parse_failed');
  });
});
