/**
 * POST /api/books/upload —— 认知资产书籍文件上传。
 *
 * Body (JSON): { bookId, filename, contentType, base64 }
 *   - bookId: 已有/新建书的 id（前端生成，确保 idempotent）
 *   - filename: 原始文件名（仅取 basename，避免路径注入）
 *   - contentType: 文件 MIME
 *   - base64: 文件内容的 base64 编码（前端 FileReader.readAsDataURL 取逗号后那段）
 *
 * 路径规范：cog/{uid}/{bookId}/{filename}
 * 限制：≤ 20MB（二进制），仅 PDF / TXT / MD
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse, errorResponse, readBody, bodyStr } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';
import { putObject } from '../../../lib/storage.ts';

const BUCKET = 'books';
const MAX_BYTES = 20 * 1024 * 1024; // 20MB
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

// 对象 key 必须用 ASCII：Supabase Storage 拒绝《》等 CJK 符号 / 控制字符（→ InvalidKey）。
// 真实中文名通过返回的 file.name 保留作展示，不影响读取（读取走 file.path + 签名 URL）。
function safeObjectKey(name: string): string {
  const base = String(name || 'file').split(/[\\/]/).pop() || 'file';
  const m = base.match(/\.([a-zA-Z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : 'bin';
  return `file_${Date.now().toString(36)}.${ext}`;
}

function decodeBase64(s: string): Uint8Array {
  // 容忍「data:application/pdf;base64,XXX」这种 dataURL 形式
  const i = s.indexOf(',');
  const pure = i >= 0 && s.slice(0, i).includes('base64') ? s.slice(i + 1) : s;
  const bin = atob(pure);
  const out = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
  return out;
}

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  const user = await requireUser(request, env);

  const body = await readBody(request);
  const bookId = bodyStr(body, 'bookId');
  const filename = bodyStr(body, 'filename');
  const contentType = bodyStr(body, 'contentType') || 'application/octet-stream';
  const base64 = bodyStr(body, 'base64');

  if (!bookId || !filename || !base64) {
    return errorResponse(400, '缺少 bookId / filename / base64');
  }
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(bookId)) {
    return errorResponse(400, 'bookId 格式不合法');
  }
  if (!ALLOWED_TYPES.has(contentType)) {
    return errorResponse(400, `不支持的文件类型: ${contentType}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return errorResponse(400, 'base64 解码失败');
  }
  if (bytes.byteLength > MAX_BYTES) {
    return errorResponse(413, `文件过大（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB，限 20MB）`);
  }

  const safeName = safeObjectKey(filename);
  const path = `cog/${user.uid}/${bookId}/${safeName}`;

  try {
    await putObject(env, BUCKET, path, bytes, contentType);
  } catch (e: any) {
    return jsonResponse(200, { ok: false, error: 'STORAGE_PUT_FAILED', detail: String(e?.message || e) });
  }

  return jsonResponse(200, {
    ok: true,
    path,
    file: {
      name: filename, // 真实中文名（仅展示）；对象 key 已是 ASCII，避免 InvalidKey
      type: contentType,
      size: bytes.byteLength,
      path,
      uploadedAt: Date.now(),
    },
  });
});
