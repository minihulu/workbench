/**
 * POST /api/books/delete —— 删除书籍文件。
 *
 * Body (JSON): { path }
 *   - path 必须以 cog/{uid}/ 开头
 * 用途：删书时同时清掉 Storage 里的文件，避免孤儿对象。
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse, errorResponse, readBody, bodyStr } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';
import { removeObject } from '../../../lib/storage.ts';

const BUCKET = 'books';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  const user = await requireUser(request, env);

  const body = await readBody(request);
  const path = bodyStr(body, 'path');

  if (!path) return errorResponse(400, '缺少 path');

  const prefix = `cog/${user.uid}/`;
  if (!path.startsWith(prefix)) {
    return errorResponse(403, '路径与当前用户不匹配');
  }

  try {
    await removeObject(env, BUCKET, path);
  } catch (e: any) {
    return jsonResponse(200, { ok: false, error: 'STORAGE_DELETE_FAILED', detail: String(e?.message || e) });
  }
  return jsonResponse(200, { ok: true });
});
