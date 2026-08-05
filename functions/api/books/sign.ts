/**
 * POST /api/books/sign —— 给私有 bucket 文件签发 1 小时可读 URL。
 *
 * Body (JSON): { path }
 *   - path 必须以 cog/{uid}/ 开头（防越权读别人文件）
 * 用途：前端拿到 URL 后塞进 iframe (PDF) 或 fetch (TXT/MD)。
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse, errorResponse, readBody, bodyStr } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';
import { createSignedUrl } from '../../../lib/storage.ts';

const BUCKET = 'books';
const SIGN_TTL_SEC = 3600; // 1 小时

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  const user = await requireUser(request, env);

  const body = await readBody(request);
  const path = bodyStr(body, 'path');

  if (!path) return errorResponse(400, '缺少 path');

  // 路径隔离：必须以 cog/{本用户 uid}/ 开头
  const prefix = `cog/${user.uid}/`;
  if (!path.startsWith(prefix)) {
    return errorResponse(403, '路径与当前用户不匹配');
  }

  try {
    const url = await createSignedUrl(env, BUCKET, path, SIGN_TTL_SEC);
    return jsonResponse(200, { ok: true, url, expiresIn: SIGN_TTL_SEC });
  } catch (e: any) {
    return jsonResponse(200, { ok: false, error: 'STORAGE_SIGN_FAILED', detail: String(e?.message || e) });
  }
});
