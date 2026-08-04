/**
 * POST /api/admin/backup —— 对应 server.py 路由 L1138-1142 + `do_backup()` L405。
 *
 * 修正（BUG-5）：Python 版 `do_backup()` 把所有异常吞掉只 print 一行警告，
 * 路由无条件返回 200 {"ok":true} —— 备份失败了也说成功，属于「撒谎的接口」。
 *
 * Cloudflare Pages 上没有文件系统、也没有常驻线程跑 backup_loop，
 * 备份这件事在这一层根本做不了。所以直接返回 501 并说明替代方案，不再撒谎。
 *
 * 替代方案（写在 CLOUDFLARE.md 里）：
 *   1. Supabase 自带的 Daily Backups（Pro 档自动，Free 档可用 pg_dump 手动导）
 *   2. 后续要在 Cloudflare 侧留副本，接 R2 + 一个独立 Worker 的 Cron Trigger
 *      （Pages Functions 本身不支持 Cron，见 CLOUDFLARE.md「定时任务」一节）
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse } from '../../../lib/json.ts';
import { requireAdmin } from '../../../lib/auth.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  requireAdmin(request, env);
  return jsonResponse(501, {
    error:
      'Cloudflare Pages 上没有文件系统，无法在此做备份。' +
      '请使用 Supabase 自带备份（Dashboard → Database → Backups，或 pg_dump 导出），' +
      '或后续接 R2 + 独立 Worker 的 Cron Trigger。详见 CLOUDFLARE.md。',
    ok: false,
  });
});
