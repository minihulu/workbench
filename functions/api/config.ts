/**
 * GET /api/config —— 对应 server.py `api_config()` L589-601。
 *
 * 前端依赖（workbench.html）：
 *   L2274  cfg.version / cfg.pid          → 诊断面板打印
 *   L2275  cfg.workdir                    → 诊断面板打印
 *   L2284  cfg.github_proxy / github_proxy_detail
 *   L2796  cfg.qq_login   → #lgQQ 显隐
 *   L2797  cfg.wechat_login → #lgWX 显隐
 *   L2802  cfg.register_require_invite → 邀请码输入框显隐
 * 这些字段一个都不能少。
 *
 * Serverless 适配：
 *   pid     → 0                  （Worker 无进程号）
 *   workdir → "cloudflare-pages" （Worker 无文件系统）
 *   前端只是把它们打印到诊断文本里，不做任何逻辑判断（已核对 L2274-2275）。
 *
 * qq_login / wechat_login 恒为 false：6 个 OAuth 端点未迁移
 * （配置从未开启 + server.py:778/811 成功路径 100% TypeError + 建表缺 password_hash 列，
 *  是坏的死代码）。
 */
import { VERSION, envStr, registerOpen, registerRequireInvite, type Env } from '../../lib/env.ts';
import { guard, jsonResponse } from '../../lib/json.ts';

export const onRequestGet: PagesFunction<Env> = guard(async ({ env }) => {
  const ghToken = envStr(env, 'GH_TOKEN');
  return jsonResponse(200, {
    app: 'workbench',
    version: VERSION,
    pid: 0,
    workdir: 'cloudflare-pages',
    register_open: registerOpen(env),
    register_require_invite: registerRequireInvite(env),
    github_proxy: Boolean(ghToken),
    github_proxy_detail: ghToken ? 'GH_TOKEN' : null,
    qq_login: false,
    wechat_login: false,
  });
});
