/**
 * GET /api/health —— 对应 server.py L1049-1051。
 *
 * Python 原样：
 *   {"ok": True,
 *    "github_proxy": bool(GH_TOKEN or GH_PROXY_DICT),
 *    "proxy": GH_PROXY_DICT or (GH_TOKEN and "GH_TOKEN")}
 *
 * Worker 上没有出网代理概念（边缘节点直连 GitHub），GH_PROXY_DICT 恒为 None，
 * 所以 `proxy` 退化成：配了 GH_TOKEN → "GH_TOKEN"，否则 ""（Python 里
 * `"" and "GH_TOKEN"` 求值就是空串，这里逐字复刻）。
 */
import { envStr, type Env } from '../../lib/env.ts';
import { guard, jsonResponse } from '../../lib/json.ts';

export const onRequestGet: PagesFunction<Env> = guard(async ({ env }) => {
  const ghToken = envStr(env, 'GH_TOKEN');
  return jsonResponse(200, {
    ok: true,
    github_proxy: Boolean(ghToken),
    proxy: ghToken ? 'GH_TOKEN' : '',
  });
});
