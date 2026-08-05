/**
 * GET /api/sync/pull —— 拉取当前用户的云端 payload。
 *
 * 前端 workbench.html:2813 调用，期望返回 { payload, updated }。
 * 鉴权：requireUser（Bearer token → JWT 校验 → profiles 存在）。
 * 存储：PostgREST 读 sync 表（service_role 绕过 RLS）。
 *
 * 注意：PostgREST 查单行若不存在返回空数组 []（HTTP 200），不是 404，
 * 所以直接取 rows[0] ?? 缺省即可。
 */
import { guard, jsonResponse } from '../../lib/json.ts';
import { requireUser } from '../../lib/auth.ts';
import { postgrest, eqFilter, SupabaseError } from '../../lib/supabase.ts';
import type { Env } from '../../lib/env.ts';

export const onRequestGet = guard<{ request: Request; env: Env }>(async ({ request, env }) => {
  const { uid } = await requireUser(request, env);

  const res = await postgrest(
    env,
    `/sync?${eqFilter('uid', uid)}&select=payload,updated_at&limit=1`,
  );
  if (!res.ok) throw new SupabaseError(res.status, await res.text(), '读取 sync');

  const rows = (await res.json()) as Array<{ payload?: Record<string, unknown>; updated_at?: number }>;
  const row = rows[0];
  return jsonResponse(200, {
    payload: row?.payload ?? {},
    updated: row?.updated_at ?? 0,
  });
});
