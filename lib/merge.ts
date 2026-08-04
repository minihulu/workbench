/**
 * 记录级合并 —— **空壳，留给同步层负责人实现**。
 *
 * 语义蓝本（三处必须保持逐字一致，改一处就要三处一起改）：
 *   - workbench.html      L1284  mergeRecords(local, inc)   ← 前端
 *   - server.py           L373   merge_records(local, inc)
 *   - supabase_store.py   L264   merge_records(local, inc)
 *
 * 规则：
 *   1. 按 `id` 建索引做记录级合并（不是整数组覆盖）
 *   2. `updatedAt` 大者胜
 *   3. `updatedAt` 平局时 `deviceId` 字典序大者胜
 *   4. 结果按 `updatedAt` 升序排序
 *   5. 没有 `id` 的记录直接丢弃
 *
 * settings 的合并规则不在这里，见 supabase_store.py push_payload L433：
 *   `{...cur.settings, ...(inc.settings 里 truthy 的键)}`
 *
 * TODO(同步层): 实现下面两个函数，并补齐单元测试（至少覆盖上面 5 条规则 +
 *               空数组 / null / 缺字段的边界）。
 */

/** 业务记录的最小约定 —— 只有这三个字段参与合并 */
export interface SyncRecord {
  id: string;
  updatedAt?: number;
  deviceId?: string;
  [key: string]: unknown;
}

/**
 * 记录级合并。
 * TODO(同步层): 实现。
 */
export function mergeRecords(_local: SyncRecord[] | null, _inc: SyncRecord[] | null): SyncRecord[] {
  throw new Error('mergeRecords 尚未实现（由同步层负责）');
}

/**
 * 整个 payload 的合并：对 RECORD_KEYS 逐个 mergeRecords，settings 走浅合并 + truthy 过滤。
 * TODO(同步层): 实现。
 */
export function mergePayload(
  _current: Record<string, unknown>,
  _incoming: Record<string, unknown>,
): Record<string, unknown> {
  throw new Error('mergePayload 尚未实现（由同步层负责）');
}
