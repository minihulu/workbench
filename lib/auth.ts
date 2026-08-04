/**
 * 鉴权 —— 复刻 server.py `bearer()`(L361) / `auth_user()`(L342) / `require_admin()`(L964)。
 *
 * 同步层（functions/api/sync/*）直接 import requireUser 即可，无需重复实现。
 */
import { HttpError } from './json.ts';
import { claimEpoch, verifyToken } from './jwt.ts';
import { getProfileByUid } from './supabase.ts';
import type { Env } from './env.ts';

export interface AuthUser {
  /** Supabase auth.users.id (uuid) */
  uid: string;
  username: string;
}

/** server.py bearer(req)：只认 `Bearer ` 前缀，其余一律空串 */
export function bearer(request: Request): string {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/**
 * 要求已登录。失败抛 HttpError(401, '未登录')，与 Python 版的
 * `self._send_json(401, {"error": "未登录"})` 逐字一致。
 *
 * 校验链：
 *   1. Authorization: Bearer <token>
 *   2. JWT 签名 + iss/aud/exp/sub/iat（lib/jwt.ts）
 *   3. profiles 行必须存在（fail-closed，见下）
 *   4. 撤销检查：claims.epo **严格小于** profiles.token_epoch 才失效（相等通过）
 *
 * ⚠️ 与 Python 版的**有意分歧**：supabase_store.get_token_epoch(L205) 在 profiles
 * 行不存在时返回 0，requireUser 照抄的话就是 fail-open —— 用户已被删号，但只要手上
 * 那张 30 天 token 没过期，`epo >= 0` 恒成立，照样通过鉴权，等于留了个 30 天后门；
 * 之后它还会带着一个没有 profile 的 uid 去跑同步，在下游炸出语义错误的 409/500。
 * 这里改为 fail-closed：查不到 profiles 行一律 401。
 */
export async function requireUser(request: Request, env: Env): Promise<AuthUser> {
  const token = bearer(request);
  const claims = await verifyToken(env, token);
  if (!claims) throw new HttpError(401, '未登录');

  const uid = claims.sub;
  // getProfileByUid 内部走 pgSelect，非 2xx 会抛 SupabaseError（→500），
  // 不会被静默吞成 null，所以 null 只代表「行确实不存在」。
  const profile = await getProfileByUid(env, uid);
  if (!profile) throw new HttpError(401, '未登录');
  if (claimEpoch(claims) < profile.token_epoch) throw new HttpError(401, '未登录');

  return { uid, username: profile.username || claims.usr || '' };
}

/** 常量时间字符串比较，等价 Python `secrets.compare_digest` */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  // 长度不同时仍走完整轮比较，避免通过耗时泄漏长度
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * 要求管理员。server.py 从请求头 `X-Admin-Token` 取值，
 * ADMIN_TOKEN 未配置时**一律拒绝**（不是「放行」）。
 * 失败抛 HttpError(403, '无管理权限或未启用')，与 Python 版逐字一致。
 */
export function requireAdmin(request: Request, env: Env): void {
  const expected = (env.ADMIN_TOKEN || '').trim();
  const got = (request.headers.get('X-Admin-Token') || '').trim();
  if (!expected || !timingSafeEqual(got, expected)) {
    throw new HttpError(403, '无管理权限或未启用');
  }
}
