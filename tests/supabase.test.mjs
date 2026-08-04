/**
 * lib/supabase.ts 请求构造测试（mock fetch，断言 URL / method / headers / body）。
 *
 * 重点验证：
 *  - anon 与 service_role 两条鉴权路径不能串
 *  - PostgREST 过滤值的引号转义（用户名可能含 . , 等保留字符）
 *  - countStats 用的是 `used_by=not.is.null`（修复 supabase_store.py L304 的三参 .eq bug）
 *  - reset-token 用 return=representation 拿回行数（用于补 404）
 *  - deriveAuthEmail 与 Python hashlib.sha256(...)[:24] 逐字一致
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  adminCreateUser,
  bumpTokenEpoch,
  countStats,
  deriveAuthEmail,
  eqFilter,
  getInvite,
  getProfileByUsername,
  gotrue,
  claimInvite,
  releaseInvite,
  postgrest,
  resetTokenEpochByUsername,
  signInWithPassword,
  signOut,
  supabaseBase,
} from '../lib/supabase.ts';

const env = {
  SUPABASE_URL: 'https://proj.supabase.co/',
  SUPABASE_ANON_KEY: 'anon-key-aaa',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key-sss',
};

let calls = [];
const realFetch = globalThis.fetch;

/** 让下一批 fetch 返回预设响应 */
function mockFetch(responder) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method || 'GET',
      headers: Object.fromEntries(headers),
      body: init.body,
    });
    return responder(url, init) ?? new Response('[]', { status: 200 });
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('supabaseBase 去掉尾部斜杠；缺失时抛 500', () => {
  assert.equal(supabaseBase(env), 'https://proj.supabase.co');
  assert.throws(() => supabaseBase({}), (e) => e.status === 500);
});

test('postgrest 用 service_role 同时填 apikey 与 Authorization', async () => {
  mockFetch(() => new Response('[]', { status: 200 }));
  await postgrest(env, '/profiles?select=uid');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://proj.supabase.co/rest/v1/profiles?select=uid');
  assert.equal(calls[0].headers.apikey, 'service-key-sss');
  assert.equal(calls[0].headers.authorization, 'Bearer service-key-sss');
  assert.equal(calls[0].headers.accept, 'application/json');
});

test('postgrest 带 body 时自动补 Content-Type', async () => {
  mockFetch(() => new Response('[]', { status: 200 }));
  await postgrest(env, '/sync', { method: 'POST', body: '{"a":1}' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['content-type'], 'application/json');
});

test('gotrue service / anon 两条路径的 key 不能串', async () => {
  mockFetch(() => new Response('{}', { status: 200 }));
  await gotrue(env, '/admin/users', { method: 'POST', body: '{}' });
  assert.equal(calls[0].url, 'https://proj.supabase.co/auth/v1/admin/users');
  assert.equal(calls[0].headers.apikey, 'service-key-sss');
  assert.equal(calls[0].headers.authorization, 'Bearer service-key-sss');

  await gotrue(env, '/token?grant_type=password', { method: 'POST', body: '{}' }, 'anon');
  assert.equal(calls[1].headers.apikey, 'anon-key-aaa');
  assert.equal(calls[1].headers.authorization, 'Bearer anon-key-aaa');
});

test('gotrue 用用户 access_token 调用（logout）', async () => {
  mockFetch(() => new Response(null, { status: 204 }));
  await gotrue(env, '/logout', { method: 'POST' }, { bearer: 'user-access-token' });
  assert.equal(calls[0].headers.authorization, 'Bearer user-access-token');
  assert.equal(calls[0].headers.apikey, 'anon-key-aaa');
});

test('缺 SUPABASE_ANON_KEY 时 anon 路径报 500（登录硬依赖）', async () => {
  mockFetch(() => new Response('{}', { status: 200 }));
  await assert.rejects(
    () => gotrue({ ...env, SUPABASE_ANON_KEY: '' }, '/token', {}, 'anon'),
    (e) => e.status === 500,
  );
});

test('eqFilter 只做 percent-encoding，绝不给值加双引号', () => {
  // 实测：PostgREST 不会剥掉 eq. 值里的双引号。
  //  - uuid 列 → 22P02 invalid input syntax for type uuid: ""<uuid>""
  //  - text 列 → 不报错但永远查不到人（表现为「所有登录都说密码错误」）
  assert.equal(eqFilter('username', 'alice'), 'username=eq.alice');
  assert.equal(eqFilter('username', 'a,b'), 'username=eq.a%2Cb');
  assert.equal(eqFilter('username', 'a.b'), 'username=eq.a.b');
  assert.equal(eqFilter('username', '张三'), 'username=eq.%E5%BC%A0%E4%B8%89');
  assert.equal(
    eqFilter('uid', '00000000-0000-4000-8000-000000000000'),
    'uid=eq.00000000-0000-4000-8000-000000000000',
  );
  assert.ok(!eqFilter('username', 'alice').includes('%22'), '不能出现被编码的双引号');
});

test('getProfileByUsername 构造正确的查询串', async () => {
  mockFetch(() => new Response(JSON.stringify([{ uid: 'u1', username: 'ali.ce' }]), { status: 200 }));
  const row = await getProfileByUsername(env, 'ali.ce');
  assert.equal(row.uid, 'u1');
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/rest/v1/profiles');
  assert.equal(u.searchParams.get('username'), 'eq.ali.ce');
  assert.equal(u.searchParams.get('limit'), '1');
  assert.equal(u.searchParams.get('select'), 'uid,username,auth_email,legacy_uid,token_epoch,created_at');
});

test('getProfileByUsername 查无此人返回 null', async () => {
  mockFetch(() => new Response('[]', { status: 200 }));
  assert.equal(await getProfileByUsername(env, 'nobody'), null);
});

test('PostgREST 非 2xx 抛 SupabaseError 且带上状态码', async () => {
  mockFetch(() => new Response('{"message":"boom"}', { status: 503 }));
  await assert.rejects(
    () => getProfileByUsername(env, 'x'),
    (e) => e.name === 'SupabaseError' && e.status === 503 && /查询 profiles/.test(e.message),
  );
});

test('bumpTokenEpoch 用 return=representation，命中 1 行 → 回传新 epoch', async () => {
  // 实测 PostgREST：带 Prefer: return=representation 时，命中行返回 200 + JSON 数组
  mockFetch(() => new Response(JSON.stringify([{ uid: 'uid-1' }]), { status: 200 }));
  const epoch = await bumpTokenEpoch(env, 'uid-1', 1700000123);
  assert.equal(epoch, 1700000123);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(
    calls[0].headers.prefer,
    'return=representation',
    'return=minimal 下命中 1 行与 0 行都是 204 空体，无法区分成功与失败',
  );
  assert.deepEqual(JSON.parse(calls[0].body), { token_epoch: 1700000123 });
  assert.ok(calls[0].url.includes('uid=eq.uid-1'));
});

test('bumpTokenEpoch 命中 0 行必须抛 404，不能假装登出成功', async () => {
  // 这是旧实现（return=minimal + 判 res.ok）漏掉的分支：
  // uid 不存在时接口会回「已登出所有设备」，实际一个 token 都没吊销。
  mockFetch(() => new Response('[]', { status: 200 }));
  await assert.rejects(
    () => bumpTokenEpoch(env, 'ghost-uid', 1700000123),
    (e) => e.name === 'SupabaseError' && e.status === 404,
    '命中 0 行必须抛错，否则是假登出（安全问题）',
  );
});

test('resetTokenEpochByUsername 用 return=representation 拿回受影响行数', async () => {
  mockFetch(() => new Response(JSON.stringify([{ uid: 'u1' }]), { status: 200 }));
  assert.equal(await resetTokenEpochByUsername(env, 'alice', 1700000000), 1);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].headers.prefer, 'return=representation');

  calls = [];
  mockFetch(() => new Response('[]', { status: 200 }));
  assert.equal(await resetTokenEpochByUsername(env, 'ghost', 1700000000), 0, '0 行 → 上层补 404');
});

test('countStats 用 used_by=not.is.null（修复 supabase_store.py L304 三参 .eq bug）', async () => {
  mockFetch(
    () =>
      new Response('[]', {
        status: 200,
        headers: { 'Content-Range': '0-0/7' },
      }),
  );
  const s = await countStats(env);
  assert.deepEqual(s, { users: 7, syncs: 7, invites_total: 7, invites_used: 7 });

  const urls = calls.map((c) => c.url).sort();
  assert.equal(urls.length, 4);
  assert.ok(urls.some((u) => u.includes('/profiles?select=uid&limit=1')));
  assert.ok(urls.some((u) => u.includes('/sync?select=uid&limit=1')));
  assert.ok(urls.some((u) => u.includes('/invites?select=code&limit=1')));
  const used = urls.find((u) => u.includes('used_by'));
  assert.ok(used, '必须有一条统计已用邀请码的查询');
  assert.ok(used.includes('used_by=not.is.null'), `应为 not.is.null，实际: ${used}`);
  for (const c of calls) assert.equal(c.headers.prefer, 'count=exact');
});

test('countStats 在缺 Content-Range 时降级为 0，不抛异常', async () => {
  mockFetch(() => new Response('[]', { status: 200 }));
  assert.deepEqual(await countStats(env), {
    users: 0,
    syncs: 0,
    invites_total: 0,
    invites_used: 0,
  });
});

test('getInvite 按 code 查', async () => {
  mockFetch(() => new Response(JSON.stringify([{ code: 'wb-a', used_by: null }]), { status: 200 }));
  const inv = await getInvite(env, 'wb-a');
  assert.equal(inv.code, 'wb-a');
  assert.ok(calls[0].url.includes('code=eq.wb-a'));
});

test('claimInvite 是真 CAS：过滤必须带 used_by=is.null', async () => {
  mockFetch(() => new Response(JSON.stringify([{ code: 'wb-a' }]), { status: 200 }));
  assert.equal(await claimInvite(env, 'wb-a', 'uid-9', 1700000000), true);
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].headers.prefer, 'return=representation');
  assert.deepEqual(JSON.parse(calls[0].body), { used_by: 'uid-9', used_at: 1700000000 });
  assert.ok(calls[0].url.includes('code=eq.wb-a'));
  assert.ok(
    calls[0].url.includes('used_by=is.null'),
    '少了这个条件就是无条件覆盖写，两人拿同一个码并发注册会双双成功',
  );
});

test('claimInvite 抢不到（命中 0 行）返回 false 而不是抛错', async () => {
  mockFetch(() => new Response('[]', { status: 200 }));
  assert.equal(await claimInvite(env, 'wb-a', 'uid-9', 1700000000), false);
});

test('releaseInvite 只释放自己占的那一个', async () => {
  mockFetch(() => new Response(null, { status: 204 }));
  await releaseInvite(env, 'wb-a', 'uid-9');
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].body), { used_by: null, used_at: null });
  assert.ok(calls[0].url.includes('code=eq.wb-a'));
  assert.ok(calls[0].url.includes('used_by=eq.uid-9'), '不带这个条件会误放别人抢到的码');
});

test('adminCreateUser 走 Admin API 并带 email_confirm', async () => {
  mockFetch(() => new Response(JSON.stringify({ id: 'new-uid' }), { status: 200 }));
  const uid = await adminCreateUser(env, 'x@users.workbench.invalid', 'pw123456', 'alice');
  assert.equal(uid, 'new-uid');
  assert.equal(calls[0].url, 'https://proj.supabase.co/auth/v1/admin/users');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), {
    email: 'x@users.workbench.invalid',
    password: 'pw123456',
    email_confirm: true,
    user_metadata: { username: 'alice' },
  });
});

test('adminCreateUser 上游报错时抛 SupabaseError', async () => {
  mockFetch(() => new Response('{"msg":"email exists"}', { status: 422 }));
  await assert.rejects(
    () => adminCreateUser(env, 'a@b.c', 'pw', 'u'),
    (e) => e.name === 'SupabaseError' && e.status === 422,
  );
});

test('signInWithPassword 成功返回 access_token，失败返回 null', async () => {
  mockFetch(() => new Response(JSON.stringify({ access_token: 'at-1' }), { status: 200 }));
  assert.equal(await signInWithPassword(env, 'a@b.c', 'pw'), 'at-1');
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/auth/v1/token');
  assert.equal(u.searchParams.get('grant_type'), 'password');
  assert.equal(calls[0].headers.apikey, 'anon-key-aaa', '口令校验必须走 anon key');

  calls = [];
  mockFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
  assert.equal(await signInWithPassword(env, 'a@b.c', 'bad'), null);
});

test('signInWithPassword 网络异常时返回 null 而不是抛出', async () => {
  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  assert.equal(await signInWithPassword(env, 'a@b.c', 'pw'), null);
});

test('signOut 失败静默（best-effort）', async () => {
  globalThis.fetch = async () => {
    throw new Error('nope');
  };
  await signOut(env, 'at-1'); // 不抛即通过
});

test('deriveAuthEmail 与 Python hashlib.sha256(username)[:24] 逐字一致', async () => {
  for (const name of ['alice', '张三', 'a.b,c', '']) {
    const expectHex = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 24);
    assert.equal(
      await deriveAuthEmail(env, name),
      `${expectHex}@users.workbench.invalid`,
      `username=${name}`,
    );
  }
});

test('deriveAuthEmail 尊重 WORKBENCH_AUTH_EMAIL_DOMAIN', async () => {
  const e = await deriveAuthEmail({ ...env, WORKBENCH_AUTH_EMAIL_DOMAIN: 'x.invalid' }, 'alice');
  assert.ok(e.endsWith('@x.invalid'));
});
