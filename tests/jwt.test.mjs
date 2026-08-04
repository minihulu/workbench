/**
 * lib/jwt.ts 单元测试。
 *
 * 覆盖：签发→校验往返、9 个 claim 精确匹配、篡改被拒、alg:none 被拒、
 *       过期被拒、错误 iss/aud 被拒、密钥缺失报 500、epo 撤销语义（严格小于才失效）。
 *
 * 测试用 .mjs 而不是 .ts：Node 22.18+ 默认支持 TypeScript type-stripping，
 * 可以直接 import '../lib/xxx.ts'；用 JS 写测试则避开了 @types/node 与
 * @cloudflare/workers-types 的全局类型冲突（fetch/Request/Response 重复声明）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SignJWT } from 'jose';
import {
  JWT_ALG,
  JWT_AUD,
  JWT_ISS,
  claimEpoch,
  issueToken,
  jwtSecret,
  randomJti,
  verifyToken,
} from '../lib/jwt.ts';
import { TOKEN_TTL } from '../lib/env.ts';

const SECRET = 'test-secret-do-not-use-in-production-0123456789';
const env = { WORKBENCH_JWT_SECRET: SECRET };

const UID = '11111111-2222-3333-4444-555555555555';

function decodePayload(token) {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function decodeHeader(token) {
  const part = token.split('.')[0];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

test('签发→校验 往返成功', async () => {
  const token = await issueToken(env, UID, 'alice', 1700000000);
  const claims = await verifyToken(env, token);
  assert.ok(claims, '往返校验应通过');
  assert.equal(claims.sub, UID);
  assert.equal(claims.usr, 'alice');
  assert.equal(claims.epo, 1700000000);
  assert.equal(claims.v, 1);
});

test('claim 集合恰好是 9 个，且逐字段对齐 supabase_store.issue_token', async () => {
  const now = 1800000000;
  const token = await issueToken(env, UID, 'bob', 42, now);
  const p = decodePayload(token);

  assert.deepEqual(
    Object.keys(p).sort(),
    ['aud', 'epo', 'exp', 'iat', 'iss', 'jti', 'sub', 'usr', 'v'],
    'claim 不能多也不能少',
  );
  assert.equal(p.iss, JWT_ISS);
  assert.equal(p.aud, JWT_AUD);
  assert.equal(p.sub, UID);
  assert.equal(p.usr, 'bob');
  assert.equal(p.epo, 42);
  assert.equal(p.iat, now);
  assert.equal(p.exp, now + TOKEN_TTL);
  assert.equal(p.exp - p.iat, 2592000, 'TTL 必须是 30 天');
  assert.match(p.jti, /^[0-9a-f]{16}$/, 'jti 必须是 16 位 hex');
  assert.equal(p.v, 1);

  assert.equal(decodeHeader(token).alg, JWT_ALG);
});

test('randomJti 产出 16 位 hex 且不重复', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const jti = randomJti();
    assert.match(jti, /^[0-9a-f]{16}$/);
    seen.add(jti);
  }
  assert.equal(seen.size, 200);
});

test('篡改 payload 后校验失败', async () => {
  const token = await issueToken(env, UID, 'alice', 1);
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  payload.usr = 'attacker';
  const tampered = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
  assert.equal(await verifyToken(env, tampered), null);
});

test('换密钥签的 token 校验失败', async () => {
  const other = await issueToken({ WORKBENCH_JWT_SECRET: 'another-secret-xxxxxxxxxxxx' }, UID, 'a', 1);
  assert.equal(await verifyToken(env, other), null);
});

test('alg:none 被拒（不能绕过签名）', async () => {
  const payload = {
    iss: JWT_ISS,
    aud: JWT_AUD,
    sub: UID,
    usr: 'attacker',
    epo: 0,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    jti: 'deadbeefdeadbeef',
    v: 1,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const noneToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(payload)}.`;
  assert.equal(await verifyToken(env, noneToken), null);
});

test('HS256 之外的算法被拒（alg 混淆）', async () => {
  // 用同一把对称密钥签 HS512，若没钉死 algorithms 就会被放行
  const key = new TextEncoder().encode(SECRET);
  const hs512 = await new SignJWT({ usr: 'x', epo: 0, v: 1 })
    .setProtectedHeader({ alg: 'HS512' })
    .setIssuer(JWT_ISS)
    .setAudience(JWT_AUD)
    .setSubject(UID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .setJti('0123456789abcdef')
    .sign(key);
  assert.equal(await verifyToken(env, hs512), null);
});

test('过期 token 被拒', async () => {
  const past = Math.floor(Date.now() / 1000) - TOKEN_TTL - 10;
  const token = await issueToken(env, UID, 'alice', 1, past);
  assert.equal(await verifyToken(env, token), null);
});

test('缺少 exp / sub / iat 的 token 被拒', async () => {
  const key = new TextEncoder().encode(SECRET);
  // 缺 sub
  const noSub = await new SignJWT({ usr: 'x', epo: 0, v: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISS)
    .setAudience(JWT_AUD)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  assert.equal(await verifyToken(env, noSub), null);

  // 缺 exp
  const noExp = await new SignJWT({ usr: 'x', epo: 0, v: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISS)
    .setAudience(JWT_AUD)
    .setSubject(UID)
    .setIssuedAt()
    .sign(key);
  assert.equal(await verifyToken(env, noExp), null);

  // 缺 iat
  const noIat = await new SignJWT({ usr: 'x', epo: 0, v: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISS)
    .setAudience(JWT_AUD)
    .setSubject(UID)
    .setExpirationTime('1h')
    .sign(key);
  assert.equal(await verifyToken(env, noIat), null);
});

test('iss / aud 不匹配被拒', async () => {
  const key = new TextEncoder().encode(SECRET);
  const badIss = await new SignJWT({ usr: 'x', epo: 0, v: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('evil')
    .setAudience(JWT_AUD)
    .setSubject(UID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  assert.equal(await verifyToken(env, badIss), null);

  const badAud = await new SignJWT({ usr: 'x', epo: 0, v: 1 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISS)
    .setAudience('someone-else')
    .setSubject(UID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
  assert.equal(await verifyToken(env, badAud), null);
});

test('空 token 返回 null', async () => {
  assert.equal(await verifyToken(env, ''), null);
});

test('未配置 WORKBENCH_JWT_SECRET 时抛 HttpError(500)，且绝不回退 SUPABASE_JWT_SECRET', async () => {
  const bad = { SUPABASE_JWT_SECRET: 'should-never-be-used' };
  assert.throws(() => jwtSecret(bad), (e) => e.status === 500);
  await assert.rejects(() => issueToken(bad, UID, 'a', 0), (e) => e.status === 500);
  await assert.rejects(() => verifyToken(bad, 'x.y.z'), (e) => e.status === 500);
});

test('撤销语义：epo 严格小于库值才失效，相等通过', async () => {
  // claimEpoch 只是取值；真正的比较在 lib/auth.ts requireUser 里，
  // 这里断言比较运算的边界与 supabase_store.verify_token L258 一致：
  //   if claims.get("epo", 0) < get_token_epoch(uid): return None
  const token = await issueToken(env, UID, 'alice', 100);
  const claims = await verifyToken(env, token);
  assert.equal(claimEpoch(claims), 100);

  assert.equal(claimEpoch(claims) < 99, false, 'epo 大于库值 → 通过');
  assert.equal(claimEpoch(claims) < 100, false, 'epo 等于库值 → 通过');
  assert.equal(claimEpoch(claims) < 101, true, 'epo 小于库值 → 失效');

  // 缺 epo 时按 0 处理
  assert.equal(claimEpoch({}), 0);
});

// ============ 跨语言金标：Python 签的 token，TS 必须认 ============
//
// 这是整个迁移最隐蔽的坑，单独立测。
//
// WORKBENCH_JWT_SECRET 的值形如 64 个十六进制字符。PyJWT 拿到 str 类型的密钥时，
// 按 **UTF-8 编码成 64 字节** 使用，**不会**把它当十六进制解码成 32 字节。
// TS 侧若「聪明」地写成 hexToBytes(secret)，得到的是 32 字节的另一把钥匙 ——
// 于是所有存量 token 验签全部失败，表现为「全体用户莫名其妙被登出」，
// 而错误信息只会说「凭证无效」，几乎不可能反查到根因。
//
// 下面的 token 由 PyJWT 真实签发（固定测试密钥，非生产密钥）。
// 只要 TS 侧的编码约定与 Python 不一致，这条测试立刻变红。
const GOLDEN_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const GOLDEN_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJ3b3JrYmVuY2giLCJhdWQiOiJ3b3JrYmVuY2gtY2xpZW50Iiwic3ViIjoiMTExMTExMTEt' +
  'MjIyMi0zMzMzLTQ0NDQtNTU1NTU1NTU1NTU1IiwidXNyIjoiYWxpY2UiLCJlcG8iOjE3MDAwMDAwMDAs' +
  'ImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAyNTkyMDAwLCJqdGkiOiIwMTIzNDU2Nzg5YWJjZGVmIiwi' +
  'diI6MX0.' +
  '6o1Jhyf2VcT8nznz7mdXff8uYt7G93fQV2FUJHo29eE';

test('金标：PyJWT 用 64 位 hex 字符串密钥签出的 token，TS 必须验得过', async () => {
  assert.equal(GOLDEN_SECRET.length, 64, '前提：密钥是 64 个字符');
  assert.match(GOLDEN_SECRET, /^[0-9a-f]{64}$/, '前提：全是十六进制字符（正是诱人误解之处）');

  const keyBytes = jwtSecret({ WORKBENCH_JWT_SECRET: GOLDEN_SECRET });
  assert.equal(keyBytes.length, 64, 'UTF-8 → 64 字节；若是 32 字节说明被当 hex 解码了');
  assert.deepEqual(
    Array.from(keyBytes.slice(0, 4)),
    [0x61, 0x31, 0x62, 0x32], // 'a','1','b','2' 的 ASCII，不是 0xa1,0xb2
    '密钥必须按字符的 UTF-8 字节取',
  );

  const { jwtVerify } = await import('jose');
  const { payload } = await jwtVerify(GOLDEN_TOKEN, keyBytes, {
    algorithms: [JWT_ALG],
    issuer: JWT_ISS,
    audience: JWT_AUD,
    currentDate: new Date(1700000100 * 1000), // 冻结时间，绕开早已过期的 exp
  });

  assert.equal(payload.sub, '11111111-2222-3333-4444-555555555555');
  assert.equal(payload.usr, 'alice');
  assert.equal(payload.epo, 1700000000);
  assert.equal(payload.jti, '0123456789abcdef');
  assert.equal(payload.v, 1);
});

test('金标反向：把密钥当 hex 解码则必须验签失败（证明上条测试有鉴别力）', async () => {
  const hexBytes = new Uint8Array(GOLDEN_SECRET.match(/../g).map((h) => Number.parseInt(h, 16)));
  assert.equal(hexBytes.length, 32);

  const { jwtVerify } = await import('jose');
  await assert.rejects(
    () => jwtVerify(GOLDEN_TOKEN, hexBytes, { algorithms: [JWT_ALG] }),
    'hex 解码的密钥必须验不过，否则上条金标形同虚设',
  );
});
