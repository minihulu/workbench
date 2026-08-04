/**
 * GET /api/admin/stats —— 对应 server.py `api_admin_stats()` L970-985（Supabase 分支）。
 *
 * 鉴权：请求头 X-Admin-Token 必须等于 ADMIN_TOKEN；未配置 ADMIN_TOKEN → 403。
 *
 * 修正（BUG-2）：Python 的 supabase_store.count_stats() L304 写了
 *   `.eq("used_by", "not.is", "null")`   ← .eq() 只吃 2 个参数
 * 三参调用会构造出非法的 PostgREST 查询，导致本端点在 Supabase 模式下**必然 500**。
 * TS 版直接用查询参数 `used_by=not.is.null`（见 lib/supabase.ts countStats）。
 *
 * Serverless 适配：
 *   db_size_bytes → 0   （无本地 SQLite 文件）
 *   backup_dir    → ""  （无文件系统；备份策略见 CLOUDFLARE.md）
 */
import { VERSION, envStr, registerOpen, type Env } from '../../../lib/env.ts';
import { guard, jsonResponse } from '../../../lib/json.ts';
import { requireAdmin } from '../../../lib/auth.ts';
import { countStats } from '../../../lib/supabase.ts';

export const onRequestGet: PagesFunction<Env> = guard(async ({ request, env }) => {
  requireAdmin(request, env);
  const s = await countStats(env);
  return jsonResponse(200, {
    version: VERSION,
    storage_backend: 'supabase',
    users: s.users,
    users_with_sync: s.syncs,
    invites_total: s.invites_total,
    invites_used: s.invites_used,
    register_open: registerOpen(env),
    github_proxy: Boolean(envStr(env, 'GH_TOKEN')),
    db_size_bytes: 0,
    backup_dir: '',
  });
});
