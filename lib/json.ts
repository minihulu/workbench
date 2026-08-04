/**
 * JSON 响应封装 —— 复刻 server.py `Handler._send_json`（L452）的行为。
 *
 * Python 版只设了两个响应头：
 *   Content-Type: application/json; charset=utf-8
 *   Content-Length: <len>
 * （no-store 那一套只出现在 serve_static，JSON 接口没有，这里不擅自添加，
 *  以免改变前端/中间层的缓存行为。）
 *
 * 序列化用 ensure_ascii=False，即中文原样输出 —— JS 的 JSON.stringify 默认就是这样。
 */

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** 带状态码的业务异常。所有 handler 用统一兜底转成 JSON，绝不吐 HTML。 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function jsonResponse(
  status: number,
  obj: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = new Headers({ 'Content-Type': JSON_CONTENT_TYPE });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

/** 等价 Python 各处的 `self._send_json(code, {"error": msg})` */
export function errorResponse(
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
): Response {
  return jsonResponse(status, { error: message }, extraHeaders);
}

/** 把任意 throw 出来的东西压成可读字符串（对齐 Python 的 `"%s" % e`） */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * 统一错误兜底。
 * 修复 server.py 的既有问题：api_login 等函数没有 try/except，
 * 网络抖动时 http.server 会吐一段 Python 的 500 HTML，前端 `r.json()` 直接炸。
 * 这里保证任何情况下都返回 JSON。
 */
export function toErrorResponse(e: unknown, fallbackStatus = 500, prefix = ''): Response {
  if (e instanceof HttpError) return errorResponse(e.status, e.message);
  return errorResponse(fallbackStatus, prefix + errMessage(e));
}

/**
 * 包一层 handler，捕获所有异常并转成 JSON。
 * 用法：`export const onRequestGet = guard(async (ctx) => {...})`
 */
export function guard<C>(
  fn: (ctx: C) => Promise<Response> | Response,
  prefix = '',
): (ctx: C) => Promise<Response> {
  return async (ctx: C) => {
    try {
      return await fn(ctx);
    } catch (e) {
      return toErrorResponse(e, 500, prefix);
    }
  };
}

/** 安全解析请求体 JSON。等价 server.py `_read_body()`：解析失败一律当空对象。 */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** 从 body 里取字符串字段并 trim，等价 `(body.get(k) or "").strip()` */
export function bodyStr(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** 从 body 里取原始字符串（不 trim），等价 `body.get(k) or ""`（密码不能 trim） */
export function bodyRaw(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}
