/**
 * 端点级测试（mock fetch，不连真实 Supabase）。
 *
 * 覆盖 /api/config、/api/health、/api/auth/login、/api/auth/logout、
 * /api/github/search、/api/admin/*，重点验证：
 *   - 响应字段与 server.py 逐字段一致
 *   - 6 个既有 bug 的修复确实生效
 *   - 前端契约（限流头透传、不返回 404、qq_login 字段存在）
 */
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet as configGet } from '../functions/api/config.ts';
import { onRequestGet as healthGet } from '../functions/api/health.ts';
import { onRequestPost as loginPost } from '../functions/api/auth/login.ts';
import { onRequestPost as logoutPost } from '../functions/api/auth/logout.ts';
import { onRequestPost as signupPost } from '../functions/api/auth/signup.ts';
import { onRequestGet as ghSearchGet } from '../functions/api/github/search.ts';
import { onRequestGet as adminStatsGet } from '../functions/api/admin/stats.ts';
import { onRequestGet as adminUsersGet } from '../functions/api/admin/users.ts';
import { onRequestPost as adminSetRegisterPost } from '../functions/api/admin/set-register.ts';
import { onRequestPost as adminResetTokenPost } from '../functions/api/admin/reset-token.ts';
import { onRequestPost as adminBackupPost } from '../functions/api/admin/backup.ts';
import { onRequest as apiMiddleware } from '../functions/api/_middleware.ts';
import { issueToken } from '../lib/jwt.ts';

const BASE_ENV = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  WORKBENCH_JWT_SECRET: 'unit-test-secret-0123456789abcdef',
};

const UID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let routes = [];
const realFetch = globalThis.fetch;

/** routes: [{ match: (url, init) => bool, respond: (url, init) => Response }] */
function installFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    for (const r of routes) {
      if (r.match(url, init)) return r.respond(url, init);
    }
    throw new Error(`未 mock 的请求: ${init.method || 'GET'} ${url}`);
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** 构造 Pages Functions 的 EventContext（只用到 request / env / next） */
function ctx(request, env = BASE_ENV, next) {
  return { request, env, next, params: {}, data: {}, waitUntil() {}, passThroughOnException() {} };
}

const get = (url, headers = {}) => new Request(url, { headers });
const post = (url, body, headers = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });

beforeEach(() => {
  routes = [];
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ============================== /api/config ==============================
test('/api/config 返回 server.py api_config 的全部字段', async () => {
  const res = await configGet(ctx(get('https://x/api/config')));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const j = await res.json();

  assert.deepEqual(Object.keys(j).sort(), [
    'app',
    'github_proxy',
    'github_proxy_detail',
    'pid',
    'qq_login',
    'register_open',
    'register_require_invite',
    'version',
    'wechat_login',
    'workdir',
  ]);
  assert.equal(j.app, 'workbench');
  assert.equal(j.version, '1.1.0');
  assert.equal(j.pid, 0);
  assert.equal(j.workdir, 'cloudflare-pages');
  assert.equal(j.register_open, true, '默认开放注册');
  assert.equal(j.register_require_invite, false, '默认不需要邀请码');
  assert.equal(j.github_proxy, false);
  assert.equal(j.github_proxy_detail, null);
  // 前端 workbench.html L2796-2797 靠这两个字段控制 #lgQQ / #lgWX 显隐
  assert.equal(j.qq_login, false);
  assert.equal(j.wechat_login, false);
});

test('/api/config 的 REGISTER_OPEN / REGISTER_REQUIRE_INVITE 只认字面量 "1"', async () => {
  const cases = [
    [{ REGISTER_OPEN: '0' }, false, false],
    [{ REGISTER_OPEN: 'true' }, false, false],
    [{ REGISTER_OPEN: ' 1 ' }, true, false],
    [{ REGISTER_REQUIRE_INVITE: '1' }, true, true],
  ];
  for (const [extra, open, invite] of cases) {
    const j = await (await configGet(ctx(get('https://x/api/config'), { ...BASE_ENV, ...extra }))).json();
    assert.equal(j.register_open, open, JSON.stringify(extra));
    assert.equal(j.register_require_invite, invite, JSON.stringify(extra));
  }
});

test('/api/config 配了 GH_TOKEN 时 github_proxy_detail 为 "GH_TOKEN"', async () => {
  const j = await (
    await configGet(ctx(get('https://x/api/config'), { ...BASE_ENV, GH_TOKEN: 'ghp_x' }))
  ).json();
  assert.equal(j.github_proxy, true);
  assert.equal(j.github_proxy_detail, 'GH_TOKEN');
});

// ============================== /api/health ==============================
test('/api/health 字段与 server.py L1049-1051 一致', async () => {
  const j = await (await healthGet(ctx(get('https://x/api/health')))).json();
  assert.deepEqual(j, { ok: true, github_proxy: false, proxy: '' });

  const j2 = await (
    await healthGet(ctx(get('https://x/api/health'), { ...BASE_ENV, GH_TOKEN: 'ghp_x' }))
  ).json();
  assert.deepEqual(j2, { ok: true, github_proxy: true, proxy: 'GH_TOKEN' });
});

// ============================== /api/auth/login ==============================
function mockProfileLookup(row) {
  routes.push({
    match: (u) => u.includes('/rest/v1/profiles') && u.includes('username=eq.'),
    respond: () => json(row ? [row] : []),
  });
}

test('/api/auth/login 成功：查 profiles → anon 校验口令 → 立即 sign_out → 自签 token', async () => {
  const seen = [];
  mockProfileLookup({
    uid: UID,
    username: 'alice',
    auth_email: 'hash@users.workbench.invalid',
    legacy_uid: null,
    token_epoch: 1700000000,
    created_at: 1600000000,
  });
  routes.push({
    match: (u) => u.includes('/auth/v1/token'),
    respond: (u, init) => {
      seen.push(['signin', u, JSON.parse(init.body)]);
      return json({ access_token: 'supabase-at' });
    },
  });
  routes.push({
    match: (u) => u.includes('/auth/v1/logout'),
    respond: (u, init) => {
      seen.push(['signout', new Headers(init.headers).get('Authorization')]);
      return new Response(null, { status: 204 });
    },
  });

  const res = await loginPost(ctx(post('https://x/api/auth/login', { username: 'alice', password: 'pw123456' })));
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(Object.keys(j).sort(), ['token', 'username']);
  assert.equal(j.username, 'alice');
  assert.ok(j.token.split('.').length === 3);

  // 口令用的是 auth_email 而不是 username
  assert.deepEqual(seen[0][2], { email: 'hash@users.workbench.invalid', password: 'pw123456' });
  // Supabase session 被立即销毁
  assert.equal(seen[1][0], 'signout');
  assert.equal(seen[1][1], 'Bearer supabase-at');

  // login 绝不 bump token_epoch：签出来的 epo 必须等于库里的值
  const payload = JSON.parse(Buffer.from(j.token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.epo, 1700000000, 'login 不能 bump epoch（多端登录不互踢）');
  assert.equal(payload.sub, UID);
});

test('/api/auth/login 用户不存在 → 401', async () => {
  mockProfileLookup(null);
  const res = await loginPost(ctx(post('https://x/api/auth/login', { username: 'ghost', password: 'x' })));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: '用户名或密码错误' });
});

test('/api/auth/login 口令错误 → 401', async () => {
  mockProfileLookup({ uid: UID, username: 'alice', auth_email: 'a@b.c', token_epoch: 1 });
  routes.push({
    match: (u) => u.includes('/auth/v1/token'),
    respond: () => json({ error: 'invalid_grant' }, 400),
  });
  const res = await loginPost(ctx(post('https://x/api/auth/login', { username: 'alice', password: 'bad' })));
  assert.equal(res.status, 401);
});

test('BUG-4：Supabase 抖动时 /api/auth/login 仍返回 JSON 而不是 HTML 500', async () => {
  routes.push({
    match: (u) => u.includes('/rest/v1/profiles'),
    respond: () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
  });
  const res = await loginPost(ctx(post('https://x/api/auth/login', { username: 'a', password: 'b' })));
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const j = await res.json();
  assert.ok(typeof j.error === 'string' && j.error.length > 0, '必须是 JSON 的 {error: ...}');
});

// ============================== /api/auth/signup ==============================
test('BUG-1：邀请码无效返回 400 而不是 409「用户名已存在」', async () => {
  routes.push({
    match: (u) => u.includes('/rest/v1/invites'),
    respond: () => json([]), // 邀请码不存在
  });
  const env = { ...BASE_ENV, REGISTER_REQUIRE_INVITE: '1' };
  const res = await signupPost(
    ctx(post('https://x/api/auth/signup', { username: 'bob', password: 'pw123456', invite: 'nope' }), env),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: '邀请码无效或已使用' });
});

test('BUG-1b：REGISTER_REQUIRE_INVITE=1 但没填邀请码 → 400「需要邀请码」（Python 的 Supabase 分支漏了这个校验）', async () => {
  const env = { ...BASE_ENV, REGISTER_REQUIRE_INVITE: '1' };
  const res = await signupPost(
    ctx(post('https://x/api/auth/signup', { username: 'bob', password: 'pw123456' }), env),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: '需要邀请码' });
});

test('/api/auth/signup 用户名已存在 → 409', async () => {
  mockProfileLookup({ uid: UID, username: 'bob', auth_email: 'a@b.c', token_epoch: 1 });
  const res = await signupPost(
    ctx(post('https://x/api/auth/signup', { username: 'bob', password: 'pw123456' })),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: '用户名已存在' });
});

test('/api/auth/signup 参数校验 + REGISTER_OPEN=0 → 403', async () => {
  const r1 = await signupPost(ctx(post('https://x/api/auth/signup', { username: '', password: 'x' })));
  assert.equal(r1.status, 400);
  assert.deepEqual(await r1.json(), { error: '用户名和密码必填' });

  const r2 = await signupPost(ctx(post('https://x/api/auth/signup', { username: 'a', password: '12345' })));
  assert.equal(r2.status, 400);
  assert.deepEqual(await r2.json(), { error: '密码至少 6 位' });

  const r3 = await signupPost(
    ctx(post('https://x/api/auth/signup', { username: 'a', password: '123456' }), {
      ...BASE_ENV,
      REGISTER_OPEN: '0',
    }),
  );
  assert.equal(r3.status, 403);
  assert.deepEqual(await r3.json(), { error: '注册已关闭，请联系管理员获取邀请' });
});

test('/api/auth/signup 成功：建号 + profiles + sync，并签发 epo=created_at 的 token', async () => {
  const writes = [];
  mockProfileLookup(null);
  routes.push({
    match: (u, i) => u.includes('/auth/v1/admin/users') && i.method === 'POST',
    respond: () => json({ id: UID }),
  });
  routes.push({
    match: (u, i) => u.endsWith('/rest/v1/profiles') && i.method === 'POST',
    respond: (u, i) => {
      writes.push(['profiles', JSON.parse(i.body)]);
      return new Response(null, { status: 201 });
    },
  });
  routes.push({
    match: (u, i) => u.endsWith('/rest/v1/sync') && i.method === 'POST',
    respond: (u, i) => {
      writes.push(['sync', JSON.parse(i.body)]);
      return new Response(null, { status: 201 });
    },
  });

  const res = await signupPost(
    ctx(post('https://x/api/auth/signup', { username: 'carol', password: 'pw123456' })),
  );
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.username, 'carol');

  const prof = writes.find((w) => w[0] === 'profiles')[1];
  assert.equal(prof.uid, UID);
  assert.equal(prof.username, 'carol');
  assert.equal(prof.legacy_uid, null);
  assert.equal(prof.token_epoch, prof.created_at, '建号时 token_epoch = created_at = now');
  assert.match(prof.auth_email, /^[0-9a-f]{24}@users\.workbench\.invalid$/);

  const sync = writes.find((w) => w[0] === 'sync')[1];
  assert.equal(sync.payload_version, 0);
  assert.equal(sync.updated_at, 0);
  assert.deepEqual(Object.keys(sync.payload).sort(), [
    'cog_books', 'cog_reads', 'cog_reviews', 'cog_thoughts',
    'diary', 'directions', 'ideas', 'notes', 'reviews', 'settings', 'times',
  ]);

  const payload = JSON.parse(Buffer.from(j.token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload.epo, prof.token_epoch);
});

test('/api/auth/signup 建 profiles 失败时回滚孤儿 Auth 用户', async () => {
  let deleted = null;
  mockProfileLookup(null);
  routes.push({
    match: (u, i) => u.includes('/auth/v1/admin/users') && i.method === 'POST',
    respond: () => json({ id: UID }),
  });
  routes.push({
    match: (u, i) => u.endsWith('/rest/v1/profiles') && i.method === 'POST',
    respond: () => json({ message: 'duplicate key' }, 409),
  });
  routes.push({
    match: (u, i) => u.includes('/auth/v1/admin/users/') && i.method === 'DELETE',
    respond: (u) => {
      deleted = u;
      return new Response(null, { status: 204 });
    },
  });

  const res = await signupPost(
    ctx(post('https://x/api/auth/signup', { username: 'dave', password: 'pw123456' })),
  );
  assert.equal(res.status, 500);
  assert.ok(deleted && deleted.includes(UID), '必须回滚孤儿 Auth 用户');
});

// ============================== /api/auth/logout ==============================
test('/api/auth/logout 未登录 → 401「未登录」', async () => {
  const res = await logoutPost(ctx(post('https://x/api/auth/logout', {})));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: '未登录' });
});

test('/api/auth/logout 登录后 bump token_epoch → 200 {ok:true}', async () => {
  const token = await issueToken(BASE_ENV, UID, 'alice', 100);
  let patched = null;
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && (i.method || 'GET') === 'GET',
    respond: () => json([{ uid: UID, username: 'alice', token_epoch: 100 }]),
  });
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && i.method === 'PATCH',
    respond: (u, i) => {
      patched = JSON.parse(i.body);
      // 实测 PostgREST：带 Prefer: return=representation 命中 1 行 → 200 + 数组
      return json([{ uid: UID }]);
    },
  });
  const res = await logoutPost(
    ctx(post('https://x/api/auth/logout', {}, { Authorization: `Bearer ${token}` })),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(patched.token_epoch > 100, 'logout 必须 bump token_epoch');
});

test('撤销：token 的 epo 小于库里的 token_epoch → 401；相等 → 通过', async () => {
  const stale = await issueToken(BASE_ENV, UID, 'alice', 100);
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && (i.method || 'GET') === 'GET',
    respond: () => json([{ uid: UID, username: 'alice', token_epoch: 101 }]),
  });
  const res = await logoutPost(
    ctx(post('https://x/api/auth/logout', {}, { Authorization: `Bearer ${stale}` })),
  );
  assert.equal(res.status, 401, 'epo(100) < db(101) → 失效');

  routes = [];
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && (i.method || 'GET') === 'GET',
    respond: () => json([{ uid: UID, username: 'alice', token_epoch: 100 }]),
  });
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && i.method === 'PATCH',
    respond: () => json([{ uid: UID }]),
  });
  const res2 = await logoutPost(
    ctx(post('https://x/api/auth/logout', {}, { Authorization: `Bearer ${stale}` })),
  );
  assert.equal(res2.status, 200, 'epo(100) == db(100) → 通过');
});

test('鉴权 fail-closed：profiles 行不存在 → 401，不能按 token_epoch=0 放行', async () => {
  // Python 版 get_token_epoch 在行不存在时返回 0，照抄就是 fail-open：
  // 用户已删号，但手上那张 30 天 token 仍能通过鉴权 —— 等于开了个 30 天后门。
  const token = await issueToken(BASE_ENV, UID, 'alice', 100);
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && (i.method || 'GET') === 'GET',
    respond: () => json([]), // 查无此人
  });
  let patchCalled = false;
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && i.method === 'PATCH',
    respond: () => {
      patchCalled = true;
      return json([{ uid: UID }]);
    },
  });
  const res = await logoutPost(
    ctx(post('https://x/api/auth/logout', {}, { Authorization: `Bearer ${token}` })),
  );
  assert.equal(res.status, 401, '删号用户的存量 token 必须失效');
  assert.deepEqual(await res.json(), { error: '未登录' });
  assert.equal(patchCalled, false, '鉴权就该挡住，不应继续走到写库');
});

// ============================== /api/github/search ==============================
test('/api/github/search 透传上游 X-RateLimit-* 响应头（workbench.html L2362 依赖）', async () => {
  routes.push({
    match: (u) => u.startsWith('https://api.github.com/search/repositories'),
    respond: () =>
      json(
        { total_count: 3, items: [] },
        200,
        { 'X-RateLimit-Remaining': '29', 'X-RateLimit-Limit': '30', 'X-Other': 'drop-me' },
      ),
  });
  const res = await ghSearchGet(ctx(get('https://x/api/github/search?q=hello')));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-RateLimit-Remaining'), '29');
  assert.equal(res.headers.get('X-RateLimit-Limit'), '30');
  assert.equal(res.headers.get('X-Other'), null, '只透传 x-ratelimit-*');
  assert.equal((await res.json()).total_count, 3);
});

test('/api/github/search 默认参数与 X-GH-Token 优先级', async () => {
  let seenUrl = '';
  let seenAuth = '';
  routes.push({
    match: (u) => u.startsWith('https://api.github.com/'),
    respond: (u, i) => {
      seenUrl = u;
      seenAuth = new Headers(i.headers).get('Authorization');
      return json({ total_count: 0, items: [] });
    },
  });
  await ghSearchGet(
    ctx(get('https://x/api/github/search?q=vue', { 'X-GH-Token': 'user-tok' }), {
      ...BASE_ENV,
      GH_TOKEN: 'server-tok',
    }),
  );
  const u = new URL(seenUrl);
  assert.equal(u.searchParams.get('q'), 'vue');
  assert.equal(u.searchParams.get('sort'), 'stars');
  assert.equal(u.searchParams.get('order'), 'desc');
  assert.equal(u.searchParams.get('per_page'), '30');
  assert.equal(seenAuth, 'Bearer user-tok', '前端自带 token 优先于服务端 GH_TOKEN');
});

test('/api/github/search 缺 q → 400（不是 404）', async () => {
  const res = await ghSearchGet(ctx(get('https://x/api/github/search')));
  assert.equal(res.status, 400);
  assert.notEqual(res.status, 404, '返回 404 会让前端回退到浏览器直连 GitHub');
  assert.deepEqual(await res.json(), { error: '缺少 q 参数' });
});

test('/api/github/search 上游网络异常 → 502（不是 404）', async () => {
  routes.push({
    match: (u) => u.startsWith('https://api.github.com/'),
    respond: () => {
      throw new Error('connect timeout');
    },
  });
  const res = await ghSearchGet(ctx(get('https://x/api/github/search?q=a')));
  assert.equal(res.status, 502);
  const j = await res.json();
  assert.equal(j.error, 'github_proxy_failed');
  assert.match(j.detail, /connect timeout/);
});

test('/api/github/search 无 GH_TOKEN 时不再前置 502（Worker 边缘节点直连 GitHub 正常）', async () => {
  routes.push({
    match: (u) => u.startsWith('https://api.github.com/'),
    respond: () => json({ total_count: 1, items: [] }),
  });
  const res = await ghSearchGet(ctx(get('https://x/api/github/search?q=a')));
  assert.equal(res.status, 200, 'Python 版这里会返回 502 github_proxy_unavailable');
});

test('/api/github/search 上游 403（限流）原样透传，前端好识别', async () => {
  routes.push({
    match: (u) => u.startsWith('https://api.github.com/'),
    respond: () => json({ message: 'rate limit' }, 403, { 'X-RateLimit-Remaining': '0' }),
  });
  const res = await ghSearchGet(ctx(get('https://x/api/github/search?q=a')));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('X-RateLimit-Remaining'), '0');
});

// ============================== /api/admin/* ==============================
const ADMIN_ENV = { ...BASE_ENV, ADMIN_TOKEN: 'super-secret-admin' };
const ADMIN_HDR = { 'X-Admin-Token': 'super-secret-admin' };

test('未配置 ADMIN_TOKEN 时所有 admin 端点 403', async () => {
  const cases = [
    () => adminStatsGet(ctx(get('https://x/api/admin/stats', ADMIN_HDR))),
    () => adminUsersGet(ctx(get('https://x/api/admin/users', ADMIN_HDR))),
    () => adminSetRegisterPost(ctx(post('https://x/api/admin/set-register', { open: true }, ADMIN_HDR))),
    () => adminResetTokenPost(ctx(post('https://x/api/admin/reset-token', { username: 'a' }, ADMIN_HDR))),
    () => adminBackupPost(ctx(post('https://x/api/admin/backup', {}, ADMIN_HDR))),
  ];
  for (const fn of cases) {
    const res = await fn();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: '无管理权限或未启用' });
  }
});

test('X-Admin-Token 不匹配 → 403', async () => {
  const res = await adminStatsGet(
    ctx(get('https://x/api/admin/stats', { 'X-Admin-Token': 'wrong' }), ADMIN_ENV),
  );
  assert.equal(res.status, 403);
});

test('BUG-2：/api/admin/stats 用 used_by=not.is.null，不再 500', async () => {
  const seen = [];
  routes.push({
    match: (u) => u.includes('/rest/v1/'),
    respond: (u) => {
      seen.push(u);
      return new Response('[]', { status: 200, headers: { 'Content-Range': '0-0/5' } });
    },
  });
  const res = await adminStatsGet(ctx(get('https://x/api/admin/stats', ADMIN_HDR), ADMIN_ENV));
  assert.equal(res.status, 200, 'Python 的 Supabase 分支这里必然 500');
  const j = await res.json();
  assert.deepEqual(Object.keys(j).sort(), [
    'backup_dir', 'db_size_bytes', 'github_proxy', 'invites_total', 'invites_used',
    'register_open', 'storage_backend', 'users', 'users_with_sync', 'version',
  ]);
  assert.equal(j.storage_backend, 'supabase');
  assert.equal(j.version, '1.1.0');
  assert.equal(j.users, 5);
  assert.equal(j.users_with_sync, 5);
  assert.equal(j.db_size_bytes, 0);
  assert.equal(j.backup_dir, '');
  assert.ok(seen.some((u) => u.includes('used_by=not.is.null')));
});

test('/api/admin/users 返回 {users:[{uid,username}]}', async () => {
  routes.push({
    match: (u) => u.includes('/rest/v1/profiles'),
    respond: () =>
      json([
        { uid: 'u1', username: 'alice', created_at: 1 },
        { uid: 'u2', username: 'bob', created_at: 2 },
      ]),
  });
  const res = await adminUsersGet(ctx(get('https://x/api/admin/users', ADMIN_HDR), ADMIN_ENV));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    users: [
      { uid: 'u1', username: 'alice' },
      { uid: 'u2', username: 'bob' },
    ],
  });
});

test('/api/admin/set-register → 501（环境变量只读）', async () => {
  const res = await adminSetRegisterPost(
    ctx(post('https://x/api/admin/set-register', { open: false }, ADMIN_HDR), ADMIN_ENV),
  );
  assert.equal(res.status, 501);
  const j = await res.json();
  assert.match(j.error, /REGISTER_OPEN/);
  assert.match(j.error, /重新部署/);
  assert.equal(j.register_open, true, '同时回报当前生效值');
});

test('BUG-5：/api/admin/backup → 501，不再假装成功', async () => {
  const res = await adminBackupPost(ctx(post('https://x/api/admin/backup', {}, ADMIN_HDR), ADMIN_ENV));
  assert.equal(res.status, 501);
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.match(j.error, /Supabase|R2/);
});

test('BUG-6：/api/admin/reset-token 用户不存在 → 404（Python 的 Supabase 分支返 200）', async () => {
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && i.method === 'PATCH',
    respond: () => json([]),
  });
  const res = await adminResetTokenPost(
    ctx(post('https://x/api/admin/reset-token', { username: 'ghost' }, ADMIN_HDR), ADMIN_ENV),
  );
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: '用户不存在' });
});

test('/api/admin/reset-token 成功 → 200 {ok:true}；缺 username → 400', async () => {
  routes.push({
    match: (u, i) => u.includes('/rest/v1/profiles') && i.method === 'PATCH',
    respond: () => json([{ uid: UID }]),
  });
  const ok = await adminResetTokenPost(
    ctx(post('https://x/api/admin/reset-token', { username: 'alice' }, ADMIN_HDR), ADMIN_ENV),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  const bad = await adminResetTokenPost(
    ctx(post('https://x/api/admin/reset-token', {}, ADMIN_HDR), ADMIN_ENV),
  );
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'username 必填' });
});

// ============================== /api/* 中间件 ==============================
test('中间件把未匹配路由的 HTML 404 翻成 JSON 404', async () => {
  const next = async () => new Response('<html>Not Found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } });
  const res = await apiMiddleware(ctx(get('https://x/api/nope'), BASE_ENV, next));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(await res.json(), { error: 'not found' });
});

test('中间件把 Pages 的 SPA 回落（200 + index.html）也翻成 JSON 404', async () => {
  // Pages 没有 404.html 时会把未匹配路径回落到 index.html 并返回 200，
  // 前端对 /api/* 做 r.json() 会直接炸。实测 wrangler pages dev 就是这个行为。
  const next = async () =>
    new Response('<!DOCTYPE html><html>...</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  const res = await apiMiddleware(ctx(get('https://x/api/nope'), BASE_ENV, next));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});

test('中间件不拦 SSE（text/event-stream），同步层 /api/sync/stream 不受影响', async () => {
  const sse = new Response('data: sync\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const res = await apiMiddleware(ctx(get('https://x/api/sync/stream'), BASE_ENV, async () => sse));
  assert.equal(res, sse);
});

test('中间件兜底 handler 抛出的异常 → JSON 500', async () => {
  const next = async () => {
    throw new Error('boom');
  };
  const res = await apiMiddleware(ctx(get('https://x/api/health'), BASE_ENV, next));
  assert.equal(res.status, 500);
  const j = await res.json();
  assert.match(j.error, /服务器内部错误: boom/);
});

test('中间件不改动正常响应，也不吃掉 handler 自己的 JSON 404', async () => {
  const okRes = new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(await apiMiddleware(ctx(get('https://x/api/health'), BASE_ENV, async () => okRes)), okRes);

  const own404 = new Response('{"error":"用户不存在"}', {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  const res = await apiMiddleware(ctx(get('https://x/api/admin/reset-token'), BASE_ENV, async () => own404));
  assert.deepEqual(await res.json(), { error: '用户不存在' });
});
