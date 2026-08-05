/**
 * 记录级合并 —— 对齐 workbench.html L1284 (前端) 与 server.py L373 (Python)。
 *
 * 语义蓝本（三处必须保持逐字一致，改一处就要三处一起改）：
 *   - workbench.html      L1284  mergeRecords(local, inc)   ← 前端（pull 时）
 *   - server.py           L373  merge_records(local, inc)
 *   - supabase_store.py   L264  merge_records(local, inc)
 *   - 本文件                      mergeRecords / mergePayload ← 同步层 Functions（push 时）
 *
 * 规则：
 *   1. 按 `id` 建索引做记录级合并（不是整数组覆盖）
 *   2. `updatedAt` 大者胜
 *   3. `updatedAt` 平局时 `deviceId` 字典序大者胜
 *   4. 结果按 `updatedAt` 升序排序
 *   5. 没有 `id` 的记录直接丢弃
 *
 * settings 合并（对齐 supabase_store.push_payload）：
 *   以 cur.settings 为基础，inc.settings 中 truthy 的键覆盖（falsy 不覆盖，
 *   避免把云端已有的非默认值冲掉）。
 */

import { RECORD_KEYS } from './supabase.ts';

/** 业务记录的最小约定 —— 只有这三个字段参与合并 */
export interface SyncRecord {
  id: string;
  updatedAt?: number;
  deviceId?: string;
  [key: string]: unknown;
}

/**
 * 记录级合并。语义与 workbench.html L1284 逐字一致。
 */
export function mergeRecords(
  local: SyncRecord[] | null,
  inc: SyncRecord[] | null,
): SyncRecord[] {
  const byId: Record<string, SyncRecord> = {};
  for (const r of local || []) {
    if (r && r.id) byId[r.id] = r;
  }
  for (const r of inc || []) {
    if (!r || !r.id) continue;
    const cur = byId[r.id];
    if (!cur) {
      byId[r.id] = r;
      continue;
    }
    const ta = cur.updatedAt || 0;
    const tb = r.updatedAt || 0;
    if (tb > ta) byId[r.id] = r;
    else if (tb === ta && (r.deviceId || '') > (cur.deviceId || '')) byId[r.id] = r;
  }
  return Object.values(byId).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
}

/**
 * 整个 payload 的合并：对 RECORD_KEYS 逐个 mergeRecords，settings 走浅合并 + truthy 过滤。
 * cur = 云端当前值，inc = 前端本次传入值。updatedAt 大者胜 => 双方新增/修改都保留。
 */
export function mergePayload(
  current: Record<string, unknown> | null,
  incoming: Record<string, unknown> | null,
): Record<string, unknown> {
  const cur = current || {};
  const inc = incoming || {};
  const out: Record<string, unknown> = {};
  for (const k of RECORD_KEYS) {
    out[k] = mergeRecords(cur[k] as SyncRecord[] | null, inc[k] as SyncRecord[] | null);
  }
  const curSettings =
    cur.settings && typeof cur.settings === 'object' ? (cur.settings as Record<string, unknown>) : {};
  const incSettings =
    inc.settings && typeof inc.settings === 'object' ? (inc.settings as Record<string, unknown>) : {};
  const mergedSettings: Record<string, unknown> = { ...curSettings };
  for (const [k, v] of Object.entries(incSettings)) {
    if (v) mergedSettings[k] = v;
  }
  out.settings = mergedSettings;
  return out;
}
