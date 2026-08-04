/**
 * /api/* 统一中间件。
 *
 * 两件事：
 *  1. 兜底异常 → 保证任何情况下都返回 JSON（修复 server.py api_login 无 try/except、
 *     异常时吐 Python 500 HTML 导致前端 r.json() 直接炸的问题）。
 *  2. 没有任何 Function 匹配到的 /api/* 请求会掉到静态资源层。Pages 在没有
 *     404.html 时会按 SPA 语义回落到 index.html（HTTP 200 + text/html），
 *     前端 `r.json()` 拿到一坨 HTML 会直接炸。这里把「/api/* 却返回 HTML」
 *     一律翻译成 `{"error": "not found"}`，对齐 server.py do_POST 末尾的行为。
 *
 * 注意：Pages 的路由优先级是「精确文件 > 动态段 > 中间件包裹」，
 * _middleware.ts 不会遮蔽 health.ts / auth/login.ts / sync/pull.ts 这些具体路由。
 * 同步层的 SSE（text/event-stream）也不会被误伤 —— 只拦 text/html。
 */
import { errorResponse, toErrorResponse } from '../../lib/json.ts';
import type { Env } from '../../lib/env.ts';

export const onRequest: PagesFunction<Env> = async (ctx) => {
  let res: Response;
  try {
    res = await ctx.next();
  } catch (e) {
    return toErrorResponse(e, 500, '服务器内部错误: ');
  }
  const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
  // 静态资源层兜住的请求：要么是 HTML 回落，要么是没有 JSON body 的 404
  if (contentType.includes('text/html') || (res.status === 404 && !contentType.includes('json'))) {
    return errorResponse(404, 'not found');
  }
  return res;
};
