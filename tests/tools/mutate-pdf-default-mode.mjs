/**
 * 变异测试（PDF 默认滚动模式）：往 workbench.html 的副本里注入「本次改动可能引入/退回的缺陷」，
 * 再用 tests/pdf-default-mode.test.mjs 去跑。若测试仍然全绿，说明测试是摆设。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workbench.html'), 'utf8');

/** 源文件是 CRLF：把多行字面量里的 \n 当成「行尾」处理，避免变异静默匹配失败 */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lines = (s) => new RegExp(s.split('\n').map(esc).join('\\r?\\n'));
/** 用「多行文本 → 多行文本」做一次替换 */
const swap = (from, to) => (src) => src.replace(lines(from), to.split('\n').join('\r\n'));
/** 直接删掉一段多行文本（含行尾） */
const drop = (from) => (src) => src.replace(lines(from + '\n'), '');

const MUTANTS = [
  {
    id: 'N1 默认值退回单页（本次改动被回滚）',
    apply: (s) => s.replace("let pdfMode='scroll',", "let pdfMode='page',"),
  },
  {
    id: 'N2 首屏分支写反：滚动模式却走单页渲染',
    apply: swap(
      "  if(pdfMode === 'scroll'){\n    layoutScroll(doc, total, pagesEl, b, startPage);\n  } else {\n    await renderPage(doc, total, pagesEl, b, startPage);\n  }",
      "  if(pdfMode === 'scroll'){\n    await renderPage(doc, total, pagesEl, b, startPage);\n  } else {\n    layoutScroll(doc, total, pagesEl, b, startPage);\n  }"),
  },
  {
    id: 'N3 首屏按钮文案映射写反（滚动模式却显示「📜 滚动」）',
    apply: (s) => s.replace("${pdfMode==='scroll'?'📄 单页':'📜 滚动'}", "${pdfMode==='scroll'?'📜 滚动':'📄 单页'}"),
  },
  {
    id: 'N4 首屏容器忘记加 .scroll 类（CSS 退回单页布局）',
    apply: (s) => s.replace('<div class="pdf-pages${pdfMode===\'scroll\'?\' scroll\':\'\'}" id="pdfPages">',
                            '<div class="pdf-pages" id="pdfPages">'),
  },
  {
    id: 'N5 切换按钮文案映射写反',
    apply: (s) => s.replace("$(\"#pdfModeBtn\").textContent = pdfMode==='page' ? '📜 滚动' : '📄 单页';",
                            "$(\"#pdfModeBtn\").textContent = pdfMode==='page' ? '📄 单页' : '📜 滚动';"),
  },
  {
    id: 'N6 切换按钮只改状态不切渲染函数（点了没反应）',
    apply: drop("    if(pdfMode==='scroll') layoutScroll(doc,total,pagesEl,b,pdfCurrentPage);\n    else renderPage(doc,total,pagesEl,b,pdfCurrentPage);"),
  },
  {
    id: 'N7 切到单页时忘记摘掉容器 .scroll 类',
    apply: drop("  pagesEl.classList.remove('scroll');"),
  },
  {
    id: 'N8 切到单页时不断开 IntersectionObserver（后台继续渲染、显存泄漏）',
    apply: drop("  if(pdfIO){ try{ pdfIO.disconnect(); }catch(_){} pdfIO = null; }"),
  },
  {
    id: 'N9 切换时丢失当前页（永远回到第 1 页）',
    apply: swap("    if(pdfMode==='scroll') layoutScroll(doc,total,pagesEl,b,pdfCurrentPage);\n    else renderPage(doc,total,pagesEl,b,pdfCurrentPage);",
                "    if(pdfMode==='scroll') layoutScroll(doc,total,pagesEl,b,1);\n    else renderPage(doc,total,pagesEl,b,1);"),
  },
  {
    id: 'N10 滚动模式下上一页/下一页退回单页重绘',
    apply: swap("    if(pdfMode==='scroll'){ const s=pdfPageDivs[Math.min(total,pdfCurrentPage+1)]; if(s) s.scrollIntoView({behavior:'smooth'}); }\n    else { if(pdfCurrentPage<total) renderPage(doc,total,pagesEl,b,pdfCurrentPage+1); }",
                "    if(pdfCurrentPage<total) renderPage(doc,total,pagesEl,b,pdfCurrentPage+1);"),
  },
  {
    id: 'N11 滚动布局不再重建页槽（滚动模式空白）',
    apply: swap("    pagesEl.appendChild(slot);\n    pdfPageDivs[i] = slot;",
                "    pagesEl.appendChild(slot);"),
  },
  {
    id: 'N12 index.html 与 workbench.html 不同步（只改了一个文件）',
    applyIndex: true,
  },
];

const tmp = path.join(ROOT, '.qa-tmp');
fs.mkdirSync(tmp, { recursive: true });
let killed = 0;
const survived = [];

for (const m of MUTANTS) {
  let targetEnv = {};
  if (m.applyIndex) {
    const f = path.join(tmp, 'mut-dm-12.html');
    fs.writeFileSync(f, SRC + '\n<!-- drift -->');
    targetEnv = { QA_TARGET_HTML: f };
  } else {
    const out = m.apply(SRC);
    if (out === SRC) { survived.push(m.id + '  ⚠ 变异未生效（匹配失败）'); console.log(`SKIP      ⚠  ${m.id}`); continue; }
    const f = path.join(tmp, 'mut-dm.html');
    fs.writeFileSync(f, out);
    targetEnv = { QA_TARGET_HTML: f };
  }
  let out = '';
  try {
    out = execFileSync(process.execPath, ['--test', 'tests/pdf-default-mode.test.mjs'],
      { cwd: ROOT, env: { ...process.env, ...targetEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const mm = out.match(/^# fail (\d+)$/m);
  const failed = mm ? Number(mm[1]) : -1;
  if (failed > 0) { killed++; console.log(`KILLED  (${String(failed).padStart(2)} 个用例失败)  ${m.id}`); }
  else { survived.push(m.id); console.log(`SURVIVED  ⚠⚠  ${m.id}`); }
}

console.log('\n──────────────────────────────');
console.log(`变异被杀死: ${killed}/${MUTANTS.length}`);
if (survived.length) { console.log('存活（测试盲区）:'); survived.forEach((s) => console.log('  - ' + s)); }
else console.log('全部变异均被测试捕获 —— 测试具备真实杀伤力');
