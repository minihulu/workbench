/**
 * POST /api/auth/refresh —— 对应 server.py `api_refresh()` L683-690 + supabase_store.refresh_token() L384。
 *
 * 轮换 token：先 bump token_epoch 让所有旧 token（含刚用来鉴权的这一个）立即失效，
 * 再用新 epoch 签发。返回 200 {token, username}。
 *
 * 说明：前端 workbench.html 从未调用这个接口（grep 无命中），属于死接口，
 * 但实现成本极低，照抄保留，避免以后需要时又缺一块。
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';
import { issueToken } from '../../../lib/jwt.ts';
import { bumpTokenEpoch } from '../../../lib/supabase.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  const user = await requireUser(request, env);
  const epoch = await bumpTokenEpoch(env, user.uid);
  const token = await issueToken(env, user.uid, user.username, epoch);
  return jsonResponse(200, { token, username: user.username });
}, '刷新失败: ');
