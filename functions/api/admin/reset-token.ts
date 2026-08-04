/**
 * POST /api/admin/reset-token —— 对应 server.py `api_admin_reset_token()` L1028-1043
 *                                + supabase_store.reset_token_by_username() L395。
 *
 * 把某用户的 profiles.token_epoch 推到当前时间 → 该用户所有已签发 token 立即失效。
 *
 * 修正（BUG-6）：Python 的 Supabase 分支直接 `STORE.reset_token_by_username(username)`
 * 然后无条件返 200，用户不存在时也说「成功」（只有 SQLite 分支 L1041 有 404 分支）。
 * TS 版用 `Prefer: return=representation` 拿回受影响行数，0 行 → 404「用户不存在」。
 *
 * 修正（BUG-3）：Python 的 reset_token_by_username 不清 _epoch_cache（L201-215，TTL 60s），
 * 所以撤销最长要等 60 秒才真正生效。TS 版**完全不做缓存**，每次直查 profiles，
 * 撤销即时生效。代价是每次鉴权多一次约 20ms 的库查询。
 */
import type { Env } from '../../../lib/env.ts';
import { bodyStr, guard, jsonResponse, readBody } from '../../../lib/json.ts';
import { requireAdmin } from '../../../lib/auth.ts';
import { resetTokenEpochByUsername } from '../../../lib/supabase.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  requireAdmin(request, env);
  const body = await readBody(request);
  const username = bodyStr(body, 'username');
  if (!username) {
    return jsonResponse(400, { error: 'username 必填' });
  }
  const affected = await resetTokenEpochByUsername(env, username);
  if (affected === 0) {
    return jsonResponse(404, { error: '用户不存在' });
  }
  return jsonResponse(200, { ok: true });
});
