/**
 * POST /api/auth/logout —— 对应 server.py `api_logout()` L701-707 + supabase_store.logout() L391。
 *
 * bump token_epoch → 该用户所有已签发的 token 立即失效。返回 200 {ok:true}。
 * 未登录 → 401 {error:"未登录"}（server.py L1120-1123）。
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';
import { bumpTokenEpoch } from '../../../lib/supabase.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  const user = await requireUser(request, env);
  await bumpTokenEpoch(env, user.uid);
  return jsonResponse(200, { ok: true });
}, '登出失败: ');
