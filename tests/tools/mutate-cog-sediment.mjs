#!/usr/bin/env node
/**
 * 变异测试驱动：对 workbench.html 注入「本应被测试捕获」的缺陷副本，
 * 然后用 QA_TARGET_HTML 指向副本跑 cog-sediment-removal.test.mjs。
 *
 * 期望：每个变异体都必须让测试 FAIL。若某个变异体测试仍 PASS，
 *       说明该断言没有杀伤力，测试本身需要加强。
 *
 * 用法：node tests/tools/mutate-cog-sediment.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'workbench.html');
const OUTDIR = path.join(ROOT, 'tmp', 'mutants');
const HTML = fs.readFileSync(SRC, 'utf8');

// workbench.html 使用 CRLF 行尾。变异锚点统一按 LF 书写：
// 先把源码归一化成 LF 做匹配，写出变异体时再还原成原始行尾。
// 否则锚点会静默匹配失败，变异体形同虚设（曾经踩过这个坑）。
const EOL = HTML.includes('\r\n') ? '\r\n' : '\n';
const HTML_LF = HTML.replace(/\r\n/g, '\n');
const toSrcEol = (s) => (EOL === '\n' ? s : s.replace(/\n/g, EOL));

/** 每个变异体：{ name, apply(html) -> html }（返回 null 表示锚点没找到） */
const MUTANTS = [
  {
    name: 'M1 复活读后沉淀输入区（模拟删除回退）',
    apply: (h) => {
      const anchor = '    <div id="cogExcerptList" style="margin-top:10px;"></div>\n';
      if (!h.includes(anchor)) return null;
      const revived =
        anchor +
        `    <div class="read-sediment">\n` +
        `      <h3>🌱 读后沉淀</h3>\n` +
        `      <textarea id="crSummary" placeholder="读完后的一句话总结"></textarea>\n` +
        `      <textarea id="crViews" placeholder="核心观点"></textarea>\n` +
        `      <textarea id="crReview" placeholder="我的评价"></textarea>\n` +
        `      <button class="btn sm" id="crSedimentSave">💾 保存沉淀</button>\n` +
        `    </div>\n`;
      return h.replace(anchor, revived);
    },
  },
  {
    name: 'M2 复活书籍详情弹窗中的 cbdSummary 行',
    apply: (h) => {
      const anchor = '          <div id="cbdRecords"></div>\n';
      if (!h.includes(anchor)) return null;
      return h.replace(
        anchor,
        anchor + '          <div class="val" id="cbdSummary"></div>\n'
      );
    },
  },
  {
    name: 'M3 误删阅读进度保存绑定（既有功能被破坏）',
    apply: (h) => {
      const anchor = '  $("#crProgSave").onclick = saveCogProgress;\n';
      if (!h.includes(anchor)) return null;
      return h.replace(anchor, '');
    },
  },
  {
    name: 'M4 误删模板闭合的分号前反引号（语法破坏）',
    apply: (h) => {
      const anchor = '    <div id="cogExcerptList" style="margin-top:10px;"></div>\n    `;\n';
      if (!h.includes(anchor)) return null;
      return h.replace(
        anchor,
        '    <div id="cogExcerptList" style="margin-top:10px;"></div>\n'
      );
    },
  },
  {
    name: 'M5 误删书籍详情弹窗的 cbdRecords 元素',
    apply: (h) => {
      const anchor = '          <div id="cbdRecords"></div>\n';
      if (!h.includes(anchor)) return null;
      return h.replace(anchor, '');
    },
  },
  {
    name: 'M6 残留对已废弃字段 b.summary 的读取',
    apply: (h) => {
      const anchor = '  $("#cbdTitle").textContent = b.title;\n';
      if (!h.includes(anchor)) return null;
      return h.replace(anchor, anchor + '  const _leftover = b.summary || "";\n');
    },
  },
];

fs.mkdirSync(OUTDIR, { recursive: true });

let survived = 0;
for (const [i, m] of MUTANTS.entries()) {
  const mutated = m.apply(HTML_LF);
  if (mutated === null) {
    console.log(`⚠️  ${m.name} —— 锚点未找到，变异体无法生成（源码结构已变？）`);
    survived++;
    continue;
  }
  const file = path.join(OUTDIR, `mutant-${i + 1}.html`);
  fs.writeFileSync(file, toSrcEol(mutated));

  let killed = false;
  try {
    execFileSync(
      process.execPath,
      ['--test', 'tests/cog-sediment-removal.test.mjs'],
      { cwd: ROOT, env: { ...process.env, QA_TARGET_HTML: file }, stdio: 'pipe' }
    );
  } catch {
    killed = true; // 非零退出 = 测试失败 = 变异体被杀死
  }

  if (killed) {
    console.log(`✅ KILLED   ${m.name}`);
  } else {
    console.log(`❌ SURVIVED ${m.name}  ← 测试无杀伤力，需加强断言`);
    survived++;
  }
}

console.log(`\n变异测试结果：${MUTANTS.length - survived}/${MUTANTS.length} 被杀死`);
process.exit(survived === 0 ? 0 : 1);
