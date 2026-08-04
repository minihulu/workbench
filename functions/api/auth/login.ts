/**
 * POST /api/auth/login —— 对应 server.py `api_login()` L654-662 + supabase_store.login() L363。
 *
 * 流程：查 profiles → 用 **anon key** 打 GoTrue sign_in_with_password 校验口令
 *      → 立即 sign_out 销毁 Supabase session → 用 profiles.token_epoch 自签 token。
 *
 * 关键设计（迁移必须保持）：**login 不 bump token_epoch**。
 * 这是有意的，让多端登录互不踢下线；只有 logout / refresh / admin reset-token / signup 才 bump。
 *
 * 硬依赖：SUPABASE_ANON_KEY 缺失 → 口令无从校验 → 所有登录必然 401。
 *
 * 修正（BUG-4）：Python 的 api_login 没有 try/except，Supabase 抖动时
 * http.server 会返回一段 Python 的 500 HTML，前端 `r.json()` 直接抛异常。
 * 这里 guard() 保证任何情况下都是 JSON。
 */
import type { Env } from '../../../lib/env.ts';
import { bodyRaw, bodyStr, guard, jsonResponse, readBody } from '../../../lib/json.ts';
import { issueToken } from '../../../lib/jwt.ts';
import { getProfileByUsername, signInWithPassword, signOut } from '../../../lib/supabase.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  const body = await readBody(request);
  const username = bodyStr(body, 'username');
  const password = bodyRaw(body, 'password');

  const profile = await getProfileByUsername(env, username);
  if (!profile) {
    return jsonResponse(401, { error: '用户名或密码错误' });
  }

  const accessToken = await signInWithPassword(env, profile.auth_email, password);
  if (!accessToken) {
    return jsonResponse(401, { error: '用户名或密码错误' });
  }
  // 立即销毁 Supabase session，access/refresh token 不外泄
  await signOut(env, accessToken);

  const token = await issueToken(env, profile.uid, username, profile.token_epoch);
  return jsonResponse(200, { token, username });
});
