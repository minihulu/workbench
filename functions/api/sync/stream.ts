/**
 * GET /api/sync/stream —— 多端实时通知（SSE 长轮询降级版）。
 *
 * 前端 workbench.html:2850 用 EventSource('/api/sync/stream') 订阅，
 * 收到事件后 pullSync() 拉取其他设备的改动。
 *
 * Cloudflare Pages Functions 是无状态、无跨请求内存的，没法像本地 server.py
 * 那样维护进程内 subscribers 字典做即时 fan-out。这里改用**数据库轮询长轮询**：
 *   - 以「连接建立时」的 updated_at 作为基线
 *   - 每 ~1.5s 查一次 sync.updated_at，一旦比基线大（说明有设备 push 了）
 *     就发一个 `data: {"type":"sync"}` 事件，前端 onmessage → pullSync
 *   - 25s 超时后发 `: timeout` 关闭连接；前端 EventSource 会自动重连，形成轮询循环
 *
 * 这样「手机改了 → 电脑 1.5s 内自动刷新」的多端实时就能工作，且无状态、纯轮询 Supabase。
 */
import { guard } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';
import { postgrest, eqFilter, SupabaseError } from '../../../lib/supabase.ts';
import type { Env } from '../../../lib/env.ts';

export const onRequestGet = guard<{ request: Request; env: Env }>(async ({ request, env }) => {
  const { uid } = await requireUser(request, env);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      const close = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };

      try {
        send(': connected\n\n');

        // 基线 = 连接建立时的 updated_at
        const baseRes = await postgrest(env, `/sync?${eqFilter('uid', uid)}&select=updated_at&limit=1`);
        if (!baseRes.ok) throw new SupabaseError(baseRes.status, await baseRes.text(), '读取 sync 基线');
        const baseRows = (await baseRes.json()) as Array<{ updated_at?: number }>;
        let baseline = baseRows[0]?.updated_at ?? 0;

        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          const res = await postgrest(env, `/sync?${eqFilter('uid', uid)}&select=updated_at&limit=1`);
          if (res.ok) {
            const rows = (await res.json()) as Array<{ updated_at?: number }>;
            const u = rows[0]?.updated_at ?? 0;
            if (u > baseline) {
              send('data: {"type":"sync"}\n\n');
              close();
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        send(': timeout\n\n');
        close();
      } catch (e) {
        send('event: error\ndata: ' + JSON.stringify({ error: String(e) }) + '\n\n');
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
});
