/**
 * Supabase REST 封装 —— 直接用 fetch 打 GoTrue / PostgREST，不引入 @supabase/supabase-js。
 *
 * 两条鉴权路径必须分清（supabase_store.py 顶部安全约定）：
 *   - service_role：服务端读写 + Admin API，绝不下发前端
 *   - anon：**只**用于 sign_in_with_password 做口令校验，用完立即 sign_out
 *
 * 与 Python 版的差异：
 *   - 去掉了 _epoch_cache（60s 内存缓存）。Worker 无常驻进程，缓存本就不成立；
 *     顺带修好「admin reset-token 后撤销最长延迟 60s」的既有 bug。
 *   - 去掉了 Clash fake-IP DNS 绕过（_install_supabase_dns_bypass）。边缘节点直连无碍。
 */
import { HttpError } from './json.ts';
import { authEmailDomain, type Env } from './env.ts';

// ----------------------------- 常量（对齐 supabase_store.py） -----------------------------
export const RECORD_KEYS = [
  'times', 'ideas', 'notes', 'diary',
  'cog_reads', 'cog_books', 'cog_thoughts', 'cog_reviews',
  'directions', 'reviews',
] as const;

/** supabase_store.py EMPTY_PAYLOAD */
export function emptyPayload(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RECORD_KEYS) out[k] = [];
  out.settings = {};
  return out;
}

// ----------------------------- 行类型 -----------------------------
export interface ProfileRow {
  uid: string;
  username: string;
  auth_email: string;
  legacy_uid: string | null;
  token_epoch: number;
  created_at: number;
}

export interface InviteRow {
  code: string;
  created_by: string | null;
  created_at: number;
  used_by: string | null;
  used_at: number | null;
}

export interface SyncRow {
  uid: string;
  payload: Record<string, unknown>;
  payload_version: number;
  updated_at: number;
}

// ----------------------------- 底层请求 -----------------------------
export class SupabaseError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, context: string) {
    super(`${context} 失败 (HTTP ${status}): ${body.slice(0, 500)}`);
    this.name = 'SupabaseError';
    this.status = status;
    this.body = body;
  }
}

/** 归一化 SUPABASE_URL（去尾斜杠），缺失直接报配置错误 */
export function supabaseBase(env: Env): string {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!url) throw new HttpError(500, '服务端未配置 SUPABASE_URL');
  return url;
}

function serviceKey(env: Env): string {
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) throw new HttpError(500, '服务端未配置 SUPABASE_SERVICE_ROLE_KEY');
  return key;
}

/** anon key 可能缺失 —— 缺失时登录必然失败，由调用方决定报什么错 */
export function anonKey(env: Env): string {
  return (env.SUPABASE_ANON_KEY || '').trim();
}

export type GotrueAuth = 'service' | 'anon' | { bearer: string; apikey?: string };

/**
 * 打 GoTrue：`{SUPABASE_URL}/auth/v1{path}`
 *
 * @param auth 'service'（默认，Admin API）| 'anon'（口令校验）| {bearer} （拿用户 access_token 调，如 logout）
 */
export async function gotrue(
  env: Env,
  path: string,
  init: RequestInit = {},
  auth: GotrueAuth = 'service',
): Promise<Response> {
  const headers = new Headers(init.headers);
  let apikey: string;
  let bearer: string;
  if (auth === 'anon') {
    apikey = anonKey(env);
    if (!apikey) throw new HttpError(500, '服务端未配置 SUPABASE_ANON_KEY');
    bearer = apikey;
  } else if (auth === 'service') {
    apikey = serviceKey(env);
    bearer = apikey;
  } else {
    apikey = (auth.apikey || anonKey(env) || serviceKey(env)).trim();
    bearer = auth.bearer;
  }
  headers.set('apikey', apikey);
  headers.set('Authorization', `Bearer ${bearer}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return await fetch(`${supabaseBase(env)}/auth/v1${path}`, { ...init, headers });
}

/**
 * 打 PostgREST：`{SUPABASE_URL}/rest/v1{path}`，固定 service_role（绕过 RLS）。
 *
 * 通用到足以让同步层直接拿去读写 sync 表（含 CAS 条件更新）：
 *   postgrest(env, '/sync?uid=eq."x"&payload_version=eq.3', {
 *     method: 'PATCH',
 *     headers: { Prefer: 'return=representation' },
 *     body: JSON.stringify({ ... }),
 *   })
 */
export async function postgrest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const key = serviceKey(env);
  const headers = new Headers(init.headers);
  headers.set('apikey', key);
  headers.set('Authorization', `Bearer ${key}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return await fetch(`${supabaseBase(env)}/rest/v1${path}`, { ...init, headers });
}

async function readErr(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** PostgREST 查询，返回行数组。非 2xx 抛 SupabaseError。 */
export async function pgSelect<T>(env: Env, path: string, context: string): Promise<T[]> {
  const res = await postgrest(env, path);
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), context);
  return (await res.json()) as T[];
}

/**
 * PostgREST 精确计数。用 `Prefer: count=exact` + `limit=1`，
 * 从 Content-Range 响应头 `0-0/123` 里取斜杠后的总数。
 */
export async function pgCount(env: Env, path: string, context: string): Promise<number> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await postgrest(env, `${path}${sep}limit=1`, {
    headers: { Prefer: 'count=exact' },
  });
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), context);
  const range = res.headers.get('Content-Range') || '';
  const total = range.split('/')[1];
  const n = Number.parseInt(total ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 构造 `col=eq.<value>` 过滤串，值走 percent-encoding。
 *
 * ⚠️ 这里**不能**给值加双引号。PostgREST 只在 `in.(...)` 这类列表语法里剥引号，
 * `eq.` 的值是原样透传的 —— 实测 `uid=eq."<uuid>"` 会让 Postgres 报
 * `22P02 invalid input syntax for type uuid: ""<uuid>""`，
 * 而对 text 列（如 username）更阴险：不报错，只是永远查不到人，
 * 表现为「所有登录都说密码错误」。
 *
 * percent-encoding 已经足够：`eq.` 把 `.` 之后的全部内容当作值，
 * 逗号/点/冒号都不是分隔符，且 `%2C` 之类不会被误当语法。
 */
export function eqFilter(column: string, value: string): string {
  return `${encodeURIComponent(column)}=eq.${encodeURIComponent(value)}`;
}

// ----------------------------- profiles -----------------------------
const PROFILE_COLS = 'uid,username,auth_email,legacy_uid,token_epoch,created_at';

export async function getProfileByUsername(env: Env, username: string): Promise<ProfileRow | null> {
  const rows = await pgSelect<ProfileRow>(
    env,
    `/profiles?select=${PROFILE_COLS}&${eqFilter('username', username)}&limit=1`,
    '查询 profiles(username)',
  );
  return rows[0] ?? null;
}

export async function getProfileByUid(env: Env, uid: string): Promise<ProfileRow | null> {
  const rows = await pgSelect<ProfileRow>(
    env,
    `/profiles?select=${PROFILE_COLS}&${eqFilter('uid', uid)}&limit=1`,
    '查询 profiles(uid)',
  );
  return rows[0] ?? null;
}

/** supabase_store.py get_username(uid) */
export async function getUsername(env: Env, uid: string): Promise<string> {
  const prof = await getProfileByUid(env, uid);
  return prof?.username ?? '';
}

// 注：Python 版的 get_token_epoch(uid)（supabase_store.py L205）此处**有意不移植**。
// 它在 profiles 行不存在时返回 0，是个 fail-open 陷阱；而撤销检查现在统一走
// lib/auth.ts:requireUser（直接取 profile.token_epoch，查不到行就 401），
// 无调用点。留一个「行不存在返回 0」的导出函数只会诱导后来者踩坑，故删除。
// Python 版的 60s 缓存也一并去掉：那是同步阻塞 I/O 时代的补偿，
// Workers 下每请求直查库即可（与业务查询 Promise.all 并发，无额外延迟）。

/**
 * supabase_store.py bump_token_epoch(uid)：使该用户所有旧 token 立即失效。
 *
 * ⚠️ 必须用 `Prefer: return=representation`。已实测 PostgREST：`return=minimal` 下
 * PATCH 命中 1 行与命中 0 行**都返回 204 空体**，`res.ok` 两种情况均为 true，
 * 无法区分。若按 res.ok 判成功，uid 不存在时接口会回「已登出所有设备」而实际
 * 一个 token 都没吊销 —— 这是安全问题，不是体验问题。
 * 命中 0 行按 404 抛出，让调用方把失败如实暴露给用户。
 */
export async function bumpTokenEpoch(env: Env, uid: string, nowSec?: number): Promise<number> {
  const epoch = nowSec ?? Math.floor(Date.now() / 1000);
  const res = await postgrest(env, `/profiles?${eqFilter('uid', uid)}&select=uid`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ token_epoch: epoch }),
  });
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), 'bump token_epoch');
  const rows = (await res.json()) as unknown[];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new SupabaseError(404, `token_epoch 未更新：profiles 无此 uid`, 'bump token_epoch');
  }
  return epoch;
}

/**
 * supabase_store.py reset_token_by_username(username)。
 * 返回受影响行数 —— Python 版丢了这个信息，导致用户不存在时也返 200；
 * 这里用 `Prefer: return=representation` 拿回行数组，交给上层补 404。
 */
export async function resetTokenEpochByUsername(
  env: Env,
  username: string,
  nowSec?: number,
): Promise<number> {
  const epoch = nowSec ?? Math.floor(Date.now() / 1000);
  const res = await postgrest(env, `/profiles?${eqFilter('username', username)}&select=uid`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ token_epoch: epoch }),
  });
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), '重置 token_epoch');
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) ? rows.length : 0;
}

export async function insertProfile(env: Env, row: Partial<ProfileRow>): Promise<void> {
  const res = await postgrest(env, '/profiles', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), '写入 profiles');
}

/** supabase_store.py list_users()：按 username 排序 */
export async function listProfiles(env: Env): Promise<ProfileRow[]> {
  return await pgSelect<ProfileRow>(
    env,
    '/profiles?select=uid,username,created_at&order=username.asc',
    '查询用户列表',
  );
}

// ----------------------------- sync -----------------------------
export async function insertEmptySync(env: Env, uid: string): Promise<void> {
  const res = await postgrest(env, '/sync', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      uid,
      payload: emptyPayload(),
      payload_version: 0,
      updated_at: 0,
    }),
  });
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), '写入 sync');
}

// ----------------------------- invites -----------------------------
export async function getInvite(env: Env, code: string): Promise<InviteRow | null> {
  const rows = await pgSelect<InviteRow>(
    env,
    `/invites?select=code,used_by&${eqFilter('code', code)}&limit=1`,
    '查询邀请码',
  );
  return rows[0] ?? null;
}

/**
 * 原子抢占邀请码（取代 Python 版的 mark_invite_used）。
 *
 * ⚠️ 过滤条件里的 `used_by=is.null` 是**核心**，不能省：
 * 少了它就是无条件覆盖写，两个人拿同一个码并发注册会双双成功。
 * 加上之后这是一次真正的 CAS —— 数据库层面只有一个请求能命中该行，
 * 其余命中 0 行。配合 `return=representation` 才能把「抢到」和「没抢到」区分开
 * （实测 return=minimal 下两者都是 204 空体）。
 *
 * @returns true = 抢到；false = 已被别人用掉，或该码不存在
 */
export async function claimInvite(
  env: Env,
  code: string,
  uid: string,
  nowSec: number,
): Promise<boolean> {
  const res = await postgrest(
    env,
    `/invites?${eqFilter('code', code)}&used_by=is.null&select=code`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ used_by: uid, used_at: nowSec }),
    },
  );
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), '抢占邀请码');
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * 释放邀请码 —— 注册后续步骤失败时的尽力回滚。
 * 过滤带 `used_by=eq.<uid>`，只放自己占的那个，不会误伤别人抢到的。
 * 这里用 minimal 无妨：回滚是尽力而为，命中 0 行也没有后续动作。
 */
export async function releaseInvite(env: Env, code: string, uid: string): Promise<void> {
  const res = await postgrest(
    env,
    `/invites?${eqFilter('code', code)}&${eqFilter('used_by', uid)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ used_by: null, used_at: null }),
    },
  );
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), '释放邀请码');
}

// ----------------------------- 统计 -----------------------------
export interface CountStats {
  users: number;
  syncs: number;
  invites_total: number;
  invites_used: number;
}

/**
 * supabase_store.py count_stats()。
 *
 * 修复既有 bug：Python 版写的是
 *   .eq("used_by", "not.is", "null")     ← .eq() 只接受 2 个参数
 * 传了 3 个参数，PostgREST 侧语法错误，导致 /api/admin/stats 在 Supabase
 * 模式下必然 500。TS 版直接写查询参数 `used_by=not.is.null`。
 */
export async function countStats(env: Env): Promise<CountStats> {
  const [users, syncs, invitesTotal, invitesUsed] = await Promise.all([
    pgCount(env, '/profiles?select=uid', '统计用户数'),
    pgCount(env, '/sync?select=uid', '统计同步行数'),
    pgCount(env, '/invites?select=code', '统计邀请码总数'),
    pgCount(env, '/invites?select=code&used_by=not.is.null', '统计已用邀请码'),
  ]);
  return { users, syncs, invites_total: invitesTotal, invites_used: invitesUsed };
}

// ----------------------------- 合成邮箱 -----------------------------
/**
 * supabase_store.py derive_auth_email(username)：
 *   sha256(username).hexdigest()[:24] + "@" + AUTH_EMAIL_DOMAIN
 * 必须逐字节一致，否则老账号登录时算出的邮箱对不上 Supabase Auth 里的记录。
 */
export async function deriveAuthEmail(env: Env, username: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(username));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 24)}@${authEmailDomain(env)}`;
}

// ----------------------------- GoTrue Admin / 口令校验 -----------------------------
export interface CreatedUser {
  id: string;
}

/** Admin API 建号（等价 `auth.admin.create_user`） */
export async function adminCreateUser(
  env: Env,
  email: string,
  password: string,
  username: string,
): Promise<string> {
  const res = await gotrue(env, '/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true, // 跳过确认邮件
      user_metadata: { username },
    }),
  });
  if (!res.ok) throw new SupabaseError(res.status, await readErr(res), '建号');
  const user = (await res.json()) as CreatedUser;
  if (!user?.id) throw new SupabaseError(res.status, JSON.stringify(user), '建号（缺少 id）');
  return user.id;
}

/** 回滚孤儿 Auth 用户（best-effort，失败静默） */
export async function adminDeleteUser(env: Env, uid: string): Promise<void> {
  try {
    await gotrue(env, `/admin/users/${encodeURIComponent(uid)}`, { method: 'DELETE' });
  } catch {
    /* 与 Python 版一致：回滚失败不影响主流程报错 */
  }
}

/**
 * 用 anon key 调 GoTrue 校验口令（supabase_store.py login 的核心）。
 * 成功返回 access_token，失败返回 null。
 */
export async function signInWithPassword(
  env: Env,
  email: string,
  password: string,
): Promise<string | null> {
  let res: Response;
  try {
    res = await gotrue(
      env,
      '/token?grant_type=password',
      { method: 'POST', body: JSON.stringify({ email, password }) },
      'anon',
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

/** 立即销毁 Supabase session，access/refresh token 不外泄（best-effort） */
export async function signOut(env: Env, accessToken: string): Promise<void> {
  try {
    await gotrue(env, '/logout', { method: 'POST' }, { bearer: accessToken });
  } catch {
    /* 与 Python 版一致：sign_out 失败静默 */
  }
}

/** Free 档 7 天暂停兜底：一次轻查询证明项目仍活跃 */
export async function keepalive(env: Env): Promise<boolean> {
  try {
    await pgCount(env, '/profiles?select=uid', 'keepalive');
    return true;
  } catch {
    return false;
  }
}
