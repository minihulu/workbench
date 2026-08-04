/**
 * GET /api/admin/users —— 对应 server.py `api_admin_users()` L1006-1012（Supabase 分支）。
 *
 * 返回 {"users": [{"uid":..., "username":...}, ...]}，按 username 升序。
 * Supabase 分支不返回 token_expired（自签 JWT 是无状态的，服务端不存 token，
 * 无从判断某个 token 是否还在有效期内），与 Python 版保持一致。
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse } from '../../../lib/json.ts';
import { requireAdmin } from '../../../lib/auth.ts';
import { listProfiles } from '../../../lib/supabase.ts';

export const onRequestGet: PagesFunction<Env> = guard(async ({ request, env }) => {
  requireAdmin(request, env);
  const rows = await listProfiles(env);
  return jsonResponse(200, {
    users: rows.map((r) => ({ uid: r.uid, username: r.username })),
  });
});
