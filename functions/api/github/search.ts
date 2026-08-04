/**
 * GET /api/github/search —— 对应 server.py `github_search()` L518-560 + 路由 L1072-1085。
 *
 * 前端契约（workbench.html，必须严格遵守）：
 *   L2323  `if (r.status !== 404) return r;`
 *          → 本端点**绝不能**返回 404，否则前端会回退到浏览器直连 GitHub。
 *   L2362-2364  `res.headers.get("X-RateLimit-Remaining" / "X-RateLimit-Limit")`
 *          → 必须把上游的 x-ratelimit-* 响应头**显式**拷到自己的响应上。
 *            Pages Functions 不会自动透传上游响应头。
 *   L2322  请求头 `X-GH-Token`（用户在前端填的个人 token）优先于服务端 GH_TOKEN。
 *
 * 与 Python 版的差异（有意为之）：
 *   Python 在「既无 GH_PROXY 也无 GH_TOKEN」时直接返回 502 github_proxy_unavailable
 *   （因为家用机直连 api.github.com 基本必被墙）。Worker 跑在 Cloudflare 边缘节点，
 *   直连 GitHub 完全正常，所以这个前置拦截**不再需要**，无 token 时按匿名配额
 *   （10 次/分钟）正常代理。这是纯增益：原本必然失败的场景现在能用了。
 *
 * 进程内限流（server.py github_limiter，90 次/分钟/IP）不迁移：
 * Worker 无常驻内存，且真正的防线是 GitHub 自身的 rate limit。
 */
import { envStr, type Env } from '../../../lib/env.ts';
import { JSON_CONTENT_TYPE, errMessage, guard, jsonResponse } from '../../../lib/json.ts';

const GITHUB_SEARCH = 'https://api.github.com/search/repositories';

export const onRequestGet: PagesFunction<Env> = guard(async ({ request, env }) => {
  const url = new URL(request.url);
  const q = url.searchParams.get('q') || '';
  if (!q) {
    return jsonResponse(400, { error: '缺少 q 参数' });
  }

  const params = new URLSearchParams({
    q,
    sort: url.searchParams.get('sort') || 'stars',
    order: url.searchParams.get('order') || 'desc',
    per_page: url.searchParams.get('per_page') || '30',
  });

  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    'User-Agent': 'workbench',
  });
  // 用户自带 token 优先，其次服务端 GH_TOKEN；都没有就匿名请求
  const token = (request.headers.get('X-GH-Token') || '').trim() || envStr(env, 'GH_TOKEN');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let upstream: Response;
  try {
    upstream = await fetch(`${GITHUB_SEARCH}?${params.toString()}`, { headers });
  } catch (e) {
    // 网络层失败 → 502（对齐 Python 的 github_proxy_failed），绝不返回 404
    return jsonResponse(502, { error: 'github_proxy_failed', detail: errMessage(e) });
  }

  const body = await upstream.arrayBuffer();
  const out = new Headers({ 'Content-Type': JSON_CONTENT_TYPE });
  // 显式透传限流头（前端要读 X-RateLimit-Remaining / X-RateLimit-Limit）
  for (const [k, v] of upstream.headers) {
    if (k.toLowerCase().startsWith('x-ratelimit')) out.set(k, v);
  }
  return new Response(body, { status: upstream.status, headers: out });
});
