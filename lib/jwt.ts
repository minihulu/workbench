/**
 * 自签 JWT（HS256）—— 逐字段复刻 supabase_store.py `issue_token`(L227) / `verify_token`(L242)。
 *
 * 已经发出去的 token 必须继续能用，所以 claim 集合、iss/aud、TTL 一个都不能改。
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { HttpError } from './json.ts';
import { TOKEN_TTL, type Env } from './env.ts';

export const JWT_ISS = 'workbench';
export const JWT_AUD = 'workbench-client';
export const JWT_ALG = 'HS256';

/** 自签 token 的 9 个 claim，一个不多一个不少 */
export interface WorkbenchClaims extends JWTPayload {
  iss: string;
  aud: string;
  /** Supabase auth.users.id (uuid) */
  sub: string;
  /** username */
  usr: string;
  /** 撤销世代号，来自 profiles.token_epoch */
  epo: number;
  iat: number;
  exp: number;
  jti: string;
  v: number;
}

const encoder = new TextEncoder();

/**
 * 取 HS256 密钥。
 * 安全强约束（supabase_store.py L65 注释）：只认 WORKBENCH_JWT_SECRET，
 * **绝不**回退 SUPABASE_JWT_SECRET —— 复用 Supabase 的密钥意味着任何能拿到
 * 它的组件都能伪造我们的 token。没配就直接报错。
 */
export function jwtSecret(env: Env): Uint8Array {
  const secret = (env.WORKBENCH_JWT_SECRET || '').trim();
  if (!secret) {
    throw new HttpError(500, '服务端未配置 WORKBENCH_JWT_SECRET');
  }
  return encoder.encode(secret);
}

/** 16 位 hex 随机串，等价 Python `secrets.token_hex(8)` */
export function randomJti(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 签发 30 天 token。`nowSec` 仅供测试注入。 */
export async function issueToken(
  env: Env,
  uid: string,
  username: string,
  tokenEpoch: number,
  nowSec?: number,
): Promise<string> {
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  return await new SignJWT({ usr: username, epo: tokenEpoch, v: 1 })
    .setProtectedHeader({ alg: JWT_ALG, typ: 'JWT' })
    .setIssuer(JWT_ISS)
    .setAudience(JWT_AUD)
    .setSubject(uid)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL)
    .setJti(randomJti())
    .sign(jwtSecret(env));
}

/**
 * 校验签名 + iss/aud + exp/sub/iat 存在性。
 * 只做无状态部分；`epo` 与 profiles.token_epoch 的比对在 lib/auth.ts 里做
 * （需要查库，属于有状态校验）。
 *
 * 返回 null 表示不通过（与 Python 版 verify_token 返回 None 的语义一致，
 * 不抛异常，方便调用方统一转 401）。
 */
export async function verifyToken(env: Env, token: string): Promise<WorkbenchClaims | null> {
  if (!token) return null;
  // 密钥缺失是配置错误（500），不能被下面的 catch 吞成「token 无效」（401）
  const key = jwtSecret(env);
  let payload: JWTPayload;
  try {
    const res = await jwtVerify(token, key, {
      // 钉死算法，防 alg=none / RS256 混淆攻击
      algorithms: [JWT_ALG],
      issuer: JWT_ISS,
      audience: JWT_AUD,
      requiredClaims: ['exp', 'sub', 'iat'],
    });
    payload = res.payload;
  } catch {
    return null;
  }
  // 不依赖 jose 版本是否支持 requiredClaims，这里再显式兜一遍
  if (typeof payload.sub !== 'string' || !payload.sub) return null;
  if (typeof payload.exp !== 'number') return null;
  if (typeof payload.iat !== 'number') return null;
  return payload as WorkbenchClaims;
}

/** claim 里的 epo（缺失按 0，对齐 Python `claims.get("epo", 0)`） */
export function claimEpoch(claims: WorkbenchClaims): number {
  return typeof claims.epo === 'number' ? claims.epo : 0;
}
