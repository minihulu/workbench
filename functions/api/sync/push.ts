/**
 * POST /api/sync/push —— 把前端传入的 payload 合并写回云端。
 *
 * 前端 workbench.html:2838 调用，body 为 { payload }，期望返回 { ok, updated }。
 *
 * 流程（对齐 supabase_store.push_payload 的 CAS 语义）：
 *   1. requireUser → uid
 *   2. 读当前 sync 行（payload / payload_version / updated_at）
 *      - 若行不存在（首次同步）：先 insertEmptySync 建空行
 *   3. merged = mergePayload(云端, 传入)   ← 记录级 LWW 合并，双方新增都保留
 *   4. CAS 写回：PATCH .../sync?uid=eq.<uid>&payload_version=eq.<curVer>
 *      - 命中 0 行（版本被别人改了）= 冲突 → 重试（最多 5 次）
 *   5. 成功返回 { ok:true, updated: now }
 *
 * ⚠️ eqFilter 的值不加引号（见 lib/supabase.ts 注释），uuid 列会被 PostgREST 正确解析。
 */
import { guard, jsonResponse } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';
import {
  postgrest,
  eqFilter,
  emptyPayload,
  insertEmptySync,
  SupabaseError,
} from '../../../lib/supabase.ts';
import { mergePayload } from '../../../lib/merge.ts';
import type { Env } from '../../../lib/env.ts';

export const onRequestPost = guard<{ request: Request; env: Env }>(async ({ request, env }) => {
  const { uid } = await requireUser(request, env);

  const body = (await request.json().catch(() => ({}))) as { payload?: unknown };
  const inc =
    body && typeof body.payload === 'object' && body.payload ? (body.payload as Record<string, unknown>) : null;
  if (!inc) return jsonResponse(400, { error: '缺少 payload' });

  const now = Math.floor(Date.now() / 1000);

  for (let attempt = 0; attempt < 5; attempt++) {
    // 1) 读当前行
    const sel = await postgrest(
      env,
      `/sync?${eqFilter('uid', uid)}&select=payload,payload_version,updated_at&limit=1`,
    );
    if (!sel.ok) throw new SupabaseError(sel.status, await sel.text(), '读取 sync');

    const rows = (await sel.json()) as Array<{
      payload?: Record<string, unknown>;
      payload_version?: number;
      updated_at?: number;
    }>;

    let curPayload: Record<string, unknown>;
    let curVer: number;
    if (!rows.length) {
      // 首次同步：建空行（并发下若别人已先建，insert 会冲突，下轮重试读到行即可）
      try {
        await insertEmptySync(env, uid);
      } catch {
        /* 冲突说明别人已建，下一轮读行即可 */
      }
      curPayload = emptyPayload();
      curVer = 0;
    } else {
      curPayload = rows[0].payload ?? emptyPayload();
      curVer = rows[0].payload_version ?? 0;
    }

    // 2) 合并
    const merged = mergePayload(curPayload, inc);

    // 3) CAS 写回
    const upd = await postgrest(
      env,
      `/sync?${eqFilter('uid', uid)}&payload_version=eq.${curVer}&select=uid`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          payload: merged,
          payload_version: curVer + 1,
          updated_at: now,
        }),
      },
    );
    if (!upd.ok) throw new SupabaseError(upd.status, await upd.text(), '写入 sync');

    const updated = (await upd.json()) as unknown[];
    if (Array.isArray(updated) && updated.length > 0) {
      return jsonResponse(200, { ok: true, updated: now });
    }
    // CAS 冲突（返回空数组）：重试
  }

  return jsonResponse(409, { error: '同步冲突，请稍后重试' });
});
