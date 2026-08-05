/**
 * Supabase Storage 封装 —— 用 fetch 直接打 /storage/v1，service_role 鉴权绕过 RLS。
 *
 * 路径规范：调用方负责构造完整 object path（含 bucket 之下所有级）。
 * 上传权限粒度在函数层做（按 uid 隔离），不依赖 Storage RLS 策略，
 * 这样 Functions 不用区分「用户上传」与「后台服务上传」两条路径。
 */
import { HttpError } from './json.ts';
import type { Env } from './env.ts';

function storageBase(env: Env): string {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!url) throw new HttpError(500, '服务端未配置 SUPABASE_URL');
  return url;
}

function serviceKey(env: Env): string {
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) throw new HttpError(500, '服务端未配置 SUPABASE_SERVICE_ROLE_KEY');
  return key;
}

function authHeaders(env: Env): Headers {
  const key = serviceKey(env);
  const h = new Headers();
  h.set('apikey', key);
  h.set('Authorization', `Bearer ${key}`);
  return h;
}

/** URL 编码路径里每一段（保留 / 分隔符）。 */
export function encodeObjectPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * 上传对象到指定 bucket path。
 * @param body 文件二进制
 * @param contentType MIME（与上传文件一致即可；image/png、application/pdf 等）
 * Returns: 成功时返回 path 供后续签名/删除使用，失败抛 HttpError。
 */
export async function putObject(
  env: Env,
  bucket: string,
  path: string,
  body: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  const url = `${storageBase(env)}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`;
  const h = authHeaders(env);
  h.set('Content-Type', contentType);
  // 把 Uint8Array 转 ArrayBuffer（Cloudflare 的 fetch 接受 Uint8Array，但保险起见统一）
  const ab = body instanceof Uint8Array ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : body;
  const res = await fetch(url, { method: 'POST', headers: h, body: ab });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new HttpError(res.status, `Storage 上传失败 (HTTP ${res.status}): ${t.slice(0, 300)}`);
  }
}

/** 删除对象。404 视为幂等成功（本来就是删除语义）。 */
export async function removeObject(env: Env, bucket: string, path: string): Promise<void> {
  const url = `${storageBase(env)}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`;
  const res = await fetch(url, { method: 'DELETE', headers: authHeaders(env) });
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => '');
    throw new HttpError(res.status, `Storage 删除失败 (HTTP ${res.status}): ${t.slice(0, 300)}`);
  }
}

/**
 * 创建签名 URL（用于私有 bucket 的浏览器直读）。
 * @param expiresIn 秒数，建议 600~3600
 */
export async function createSignedUrl(
  env: Env,
  bucket: string,
  path: string,
  expiresIn: number,
): Promise<string> {
  const url = `${storageBase(env)}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodeObjectPath(path)}`;
  const h = authHeaders(env);
  h.set('Content-Type', 'application/json');
  const res = await fetch(url, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new HttpError(res.status, `Storage 签名失败 (HTTP ${res.status}): ${t.slice(0, 300)}`);
  }
  const j = (await res.json()) as { signedURL?: string };
  if (!j.signedURL) throw new HttpError(500, 'Storage 签名响应缺少 signedURL');
  // ⚠️ Supabase 签名接口返回的 signedURL 只是相对路径（/object/sign/...?token=...），
  // 必须补上 /storage/v1 前缀才是浏览器可访问的完整 URL，否则会 404「requested path is invalid」。
  return `${storageBase(env)}/storage/v1${j.signedURL}`;
}

/** 整个 buckets 列表（用于诊断，对象是否存在） */
export async function headBucket(env: Env, bucket: string): Promise<boolean> {
  const url = `${storageBase(env)}/storage/v1/bucket/${encodeURIComponent(bucket)}`;
  const res = await fetch(url, { method: 'GET', headers: authHeaders(env) });
  return res.ok;
}
