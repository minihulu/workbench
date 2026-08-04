/**
 * 环境变量绑定与读取 helper。
 *
 * 对应 Python 版 server.py 顶部的一堆 os.environ.get(...) 常量。
 * Worker 上没有进程级全局，环境变量随请求由 Pages 注入到 `env`，
 * 因此这里全部做成「传 env 进来」的纯函数。
 */

export interface Env {
  // ---- 必需 ----
  /** Supabase 项目地址，例如 https://xxxx.supabase.co */
  SUPABASE_URL: string;
  /** service_role key：服务端读写 + Admin API，绝不下发前端 */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** 自签 JWT 的 HS256 密钥。绝不复用 SUPABASE_JWT_SECRET（见 supabase_store.py 顶部安全约定） */
  WORKBENCH_JWT_SECRET: string;

  // ---- 登录硬依赖（缺失则所有 /api/auth/login 必然 401）----
  /** anon key，仅用于 GoTrue sign_in_with_password 做口令校验 */
  SUPABASE_ANON_KEY?: string;

  // ---- 可选 ----
  /** "1" 开放注册（默认 1）。Worker 上只读，/api/admin/set-register 无法改它 */
  REGISTER_OPEN?: string;
  /** "1" 注册需要邀请码（默认 0） */
  REGISTER_REQUIRE_INVITE?: string;
  /** 管理后台令牌。未设置时 /api/admin/* 全部 403 */
  ADMIN_TOKEN?: string;
  /** GitHub 服务端 token，提额到 5000/h。不设也能用（匿名 10/min） */
  GH_TOKEN?: string;
  /** 合成邮箱域名，默认 users.workbench.invalid */
  WORKBENCH_AUTH_EMAIL_DOMAIN?: string;
}

/** server.py VERSION，/api/config 与 /api/admin/stats 都会返回 */
export const VERSION = '1.1.0';

/** Token 有效期：30 天（server.py TOKEN_TTL / supabase_store.py TOKEN_TTL） */
export const TOKEN_TTL = 60 * 60 * 24 * 30;

/** supabase_store.py AUTH_EMAIL_DOMAIN 默认值 */
export const DEFAULT_AUTH_EMAIL_DOMAIN = 'users.workbench.invalid';

/** 读字符串环境变量，缺失/空白 → 默认值。等价 Python `(os.environ.get(k) or d).strip()` */
export function envStr(env: Env, key: keyof Env, dflt = ''): string {
  const v = env[key];
  return typeof v === 'string' && v.trim() ? v.trim() : dflt;
}

/**
 * 读布尔开关。Python 侧写法是 `os.environ.get(K, "1") == "1"`，
 * 即「只有字面量 1 才是 true」，这里保持同一语义（额外做了 trim，
 * 因为 Cloudflare 后台粘贴变量时容易带尾随空格）。
 */
export function envFlag(env: Env, key: keyof Env, dflt: boolean): boolean {
  const v = env[key];
  if (typeof v !== 'string' || v.trim() === '') return dflt;
  return v.trim() === '1';
}

/** 注册是否开放（只读，Worker 上无法运行时修改） */
export function registerOpen(env: Env): boolean {
  return envFlag(env, 'REGISTER_OPEN', true);
}

/** 注册是否需要邀请码 */
export function registerRequireInvite(env: Env): boolean {
  return envFlag(env, 'REGISTER_REQUIRE_INVITE', false);
}

/** 合成邮箱域名 */
export function authEmailDomain(env: Env): string {
  return envStr(env, 'WORKBENCH_AUTH_EMAIL_DOMAIN', DEFAULT_AUTH_EMAIL_DOMAIN);
}
