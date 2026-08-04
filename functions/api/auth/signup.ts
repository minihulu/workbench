/**
 * POST /api/auth/signup —— 对应 server.py `api_signup()` L603-623 + supabase_store.signup() L319。
 *
 * 成功：200 {token, username}
 *
 * 相对 Python 版的修正（BUG-1）：
 *   Python 里 supabase_store.signup 对「邀请码无效」和「用户名已存在」抛的是
 *   同一个 ConflictError（L324 / L329），server.py:617 一律翻成 409「用户名已存在」，
 *   于是填错邀请码的人会收到一句完全无关的错误提示。
 *   TS 版拆开：
 *     邀请码缺失   → 400 「需要邀请码」        （对齐 SQLite 分支 L627 的文案）
 *     邀请码无效   → 400 「邀请码无效或已使用」（对齐 SQLite 分支 L632 的文案）
 *     用户名已存在 → 409 「用户名已存在」
 *
 * 附带修正（BUG-1b）：Python 的 Supabase 分支在 REGISTER_REQUIRE_INVITE=1 但
 *   用户没填邀请码时，传的是空串 `""`，signup 里 `if invite:` 直接跳过校验 →
 *   邀请码形同虚设。TS 版补上「必填」校验（SQLite 分支本来就有，只有 Supabase 分支漏了）。
 */
import { registerOpen, registerRequireInvite, type Env } from '../../../lib/env.ts';
import { HttpError, bodyRaw, bodyStr, errMessage, guard, jsonResponse, readBody } from '../../../lib/json.ts';
import { issueToken } from '../../../lib/jwt.ts';
import {
  adminCreateUser,
  adminDeleteUser,
  claimInvite,
  deriveAuthEmail,
  getInvite,
  getProfileByUsername,
  insertEmptySync,
  insertProfile,
  releaseInvite,
} from '../../../lib/supabase.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  if (!registerOpen(env)) {
    return jsonResponse(403, { error: '注册已关闭，请联系管理员获取邀请' });
  }

  const body = await readBody(request);
  const username = bodyStr(body, 'username');
  const password = bodyRaw(body, 'password');
  const invite = bodyStr(body, 'invite');

  if (!username || !password) {
    return jsonResponse(400, { error: '用户名和密码必填' });
  }
  if (password.length < 6) {
    return jsonResponse(400, { error: '密码至少 6 位' });
  }

  const needInvite = registerRequireInvite(env);

  // ---- 邀请码预检（BUG-1 / BUG-1b：独立成 400，且真正做「必填」检查）----
  // 注意：这里**只是快速失败**，用来在建号之前就把明显无效的码挡掉、给出友好提示。
  // 它不是并发安全的判据 —— 真正的占用在下面的 claimInvite（原子 CAS）。
  if (needInvite) {
    if (!invite) {
      return jsonResponse(400, { error: '需要邀请码' });
    }
    const row = await getInvite(env, invite);
    if (!row || row.used_by) {
      return jsonResponse(400, { error: '邀请码无效或已使用' });
    }
  }

  // ---- 用户名查重 → 409 ----
  if (await getProfileByUsername(env, username)) {
    return jsonResponse(409, { error: '用户名已存在' });
  }

  const authEmail = await deriveAuthEmail(env, username);

  // ---- Admin API 建号 ----
  let uid: string;
  try {
    uid = await adminCreateUser(env, authEmail, password, username);
  } catch (e) {
    // 对齐 Python：AuthError → 400「注册失败: ...」
    return jsonResponse(400, { error: `注册失败: 建号失败: ${errMessage(e)}` });
  }

  const now = Math.floor(Date.now() / 1000);

  // ---- 原子抢占邀请码 ----
  // 位置很关键：必须在 adminCreateUser 之后（此时才有真 uid 可写进 used_by），
  // 且必须在 insertProfile 之前 —— 原来的写法是最后才标记，中间隔着
  // adminCreateUser + insertProfile + insertEmptySync 三次网络往返，
  // 上面那次「预检」和标记之间的窗口足够两个人拿同一个码同时注册成功（TOCTOU）。
  // 挪到这里后紧接着就是建行，且 claimInvite 本身是数据库层面的 CAS，
  // 同一个码不可能被两个请求同时抢到。
  let claimed = false;
  if (needInvite && invite) {
    claimed = await claimInvite(env, invite, uid, now);
    if (!claimed) {
      await adminDeleteUser(env, uid); // 回滚刚建的孤儿 Auth 用户
      return jsonResponse(400, { error: '邀请码无效或已使用' });
    }
  }

  // ---- profiles + sync 建行；失败回滚孤儿 Auth 用户 + 释放邀请码 ----
  try {
    await insertProfile(env, {
      uid,
      username,
      auth_email: authEmail,
      legacy_uid: null,
      token_epoch: now,
      created_at: now,
    });
    await insertEmptySync(env, uid);
  } catch (e) {
    if (claimed && invite) {
      // 尽力回滚，失败不掩盖原始错误
      try {
        await releaseInvite(env, invite, uid);
      } catch { /* 忽略：原始错误更重要 */ }
    }
    await adminDeleteUser(env, uid);
    throw new HttpError(500, `注册失败: ${errMessage(e)}`);
  }

  // 建号即 bump epoch（token_epoch = now），签发首个 token
  const token = await issueToken(env, uid, username, now, now);
  return jsonResponse(200, { token, username });
});
