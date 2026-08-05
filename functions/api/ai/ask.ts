/**
 * POST /api/ai/ask —— 认知资产 V2「阅读入口」的 AI 能力。
 *
 * 当前只支持 task="express"：把用户的中文思考（我的理解）翻译成
 * CET-4 / CET-6 水平的英语，并附逐词解释（中文意思 / 四六级等级 / 常见搭配 / 语境）。
 *
 * 实现说明：
 *  - 兼容 OpenAI Chat Completions 协议，默认走 DeepSeek（用户环境已知可用）。
 *  - 通过环境变量配置，零代码改动即可换模型：
 *      DEEPSEEK_API_KEY（或 AI_API_KEY）  —— 必有，缺失则返回 {ok:false,error:"AI_NOT_CONFIGURED"}
 *      AI_API_BASE                       —— 默认 https://api.deepseek.com/v1
 *      AI_MODEL                          —— 默认 deepseek-chat
 *  - 鉴权沿用同步层：必须已登录（requireUser），与现有 Functions 一致，fail-closed。
 *  - 用 JSON 模式强制结构化输出，前端直接拿到 english + words。
 */
import type { Env } from '../../../lib/env.ts';
import { guard, jsonResponse, errorResponse, readBody, bodyStr } from '../../../lib/json.ts';
import { requireUser } from '../../../lib/auth.ts';

export const onRequestPost: PagesFunction<Env> = guard(async ({ request, env }) => {
  await requireUser(request, env); // 与同步层一致：必须已登录

  const body = await readBody(request);
  const task = bodyStr(body, 'task');
  const text = bodyStr(body, 'text');
  const level = bodyStr(body, 'level') || 'cet4';

  if (!text) return errorResponse(400, 'empty text');
  if (task !== 'express') return errorResponse(400, 'unsupported task');

  const apiKey = env.DEEPSEEK_API_KEY || env.AI_API_KEY || '';
  const base = env.AI_API_BASE || 'https://api.deepseek.com/v1';
  const model = env.AI_MODEL || 'deepseek-chat';

  if (!apiKey) return jsonResponse(200, { ok: false, error: 'AI_NOT_CONFIGURED' });

  const lvlName = level === 'cet6' ? 'CET-6（大学英语六级）' : 'CET-4（大学英语四级）';
  const sys = `你是一个帮助中国学生把中文思考翻译成英语的助手，水平控制在 ${lvlName}。要求：使用简单、自然、地道的英语，不要学术化、不要复杂长难句、不要生僻词。只输出一个 JSON 对象，不要任何解释或 Markdown，格式严格为：{"english":"翻译后的英文句子","words":[{"word":"英文单词或词组","meaning":"中文意思","level":"CET-4 或 CET-6","collocations":"常见搭配，如 make an effort","context":"该词在当前句子里的意思"}]}。请为英文句子中的关键单词/词组逐一给出解释。`;
  const user = `中文：${text}\n请把上面的中文思考翻译成${level === 'cet6' ? '六级' : '四级'}水平的英语，并为句中关键英文单词逐一给出中文意思、四六级等级、常见搭配、在当前语境中的解释。`;

  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return jsonResponse(200, { ok: false, error: 'LLM_ERROR:' + r.status, detail: t.slice(0, 300) });
    }
    const j = await r.json() as any;
    const content: string = j?.choices?.[0]?.message?.content || '{}';
    let parsed: any = {};
    try { parsed = JSON.parse(content); } catch { parsed = { english: content }; }
    return jsonResponse(200, {
      ok: true,
      english: typeof parsed.english === 'string' ? parsed.english : '',
      words: Array.isArray(parsed.words) ? parsed.words : [],
    });
  } catch (e) {
    return jsonResponse(200, { ok: false, error: 'FETCH_FAIL:' + String(e) });
  }
});
