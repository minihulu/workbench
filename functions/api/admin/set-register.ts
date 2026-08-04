/**
 * POST /api/admin/set-register —— 对应 server.py `api_admin_set_register()` L1023-1026。
 *
 * Python 版靠 `global REGISTER_OPEN` 改进程内可变全局。Worker 上：
 *   - 没有常驻进程，每个请求可能落在不同的边缘节点上
 *   - env 是只读的
 * 所以运行时开关**根本无法生效**。与其返回 200 骗人（改了没用，且下次冷启动就丢），
 * 不如老实返回 501 并告诉调用方正确做法。
 *
 * 依然先做鉴权（403 优先于 501），避免未授权者探测出这个端点的存在。
 */
import { registerOpen, type Env } from '../../../lib/env.ts';
import { guard, jsonResponse } from '../../../lib/json.ts';
import { requireAdmin } from '../../../lib/auth.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  requireAdmin(request, env);
  return jsonResponse(501, {
    error:
      'Cloudflare Pages 上无法在运行时切换注册开关（环境变量只读）。' +
      '请在 Cloudflare Pages 后台 → Settings → Environment variables 里修改 REGISTER_OPEN（1 开 / 0 关）后重新部署。',
    register_open: registerOpen(env),
  });
});
