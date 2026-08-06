/**
 * 变异测试：对 workbench.html 注入「典型缺陷」，验证 pdf-anno-sidebar.test.mjs 真的能杀掉它们。
 * 每个变异体都必须让测试至少失败 1 条；若某个变异体「存活」，说明该维度是测试盲区。
 *
 * 用法：node tests/tools/mutate-pdf-anno-sidebar.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workbench.html'), 'utf8');
const TEST = path.join(ROOT, 'tests', 'pdf-anno-sidebar.test.mjs');

/** [名称, 变异函数]：返回 null 表示锚点没找到（源码漂移，需更新变异体） */
const MUTANTS = [
  ['同步钩子断开：afterAnnoChange 不再刷新侧栏',
    (s) => s.replace('  renderPdfAnnoList();                                  // 阅读器内批注侧栏', '  //')],
  ['排序退化：丢掉页内 startOffset 次序',
    (s) => s.replace('(Number(a.page)||0)-(Number(b.page)||0) || (a.startOffset||0)-(b.startOffset||0)',
      '(Number(a.page)||0)-(Number(b.page)||0)')],
  ['排序退化：按字符串比页码（11 会排到 2 前面）',
    (s) => s.replace('(Number(a.page)||0)-(Number(b.page)||0) ||', 'String(a.page).localeCompare(String(b.page)) ||')],
  ['徽标语义错：显示筛选后条数而非全书总数',
    (s) => s.replace('const total = bookId ? annoCountOfBook(bookId) : 0;',
      'const total = bookId ? annosOf(bookId,null).filter(a=> pdfAnnoFilter==="all" || a.type===pdfAnnoFilter).length : 0;')],
  ['徽标 0 条时显示 "0" 而不是留空',
    (s) => s.replace('badge.textContent = total ? String(total) : "";', 'badge.textContent = String(total);')],
  ['XSS：selectedText 不转义',
    (s) => s.replace('“${esc(a.selectedText)}”', '“${a.selectedText}”')],
  ['XSS：笔记正文 text 不转义',
    (s) => s.replace('<div class="a-under">${esc(a.text)}</div>', '<div class="a-under">${a.text}</div>')],
  ['筛选失效：忽略 pdfAnnoFilter',
    (s) => s.replace("if(pdfAnnoFilter !== 'all') list = list.filter(a=> a.type === pdfAnnoFilter);", '')],
  ['空态不分家：筛选无命中与全空共用一句文案',
    (s) => s.replace("(total ? '该类型下还没有批注' : '还没有批注。选中正文点「🖍 / 💬 / 💡」写下第一条。')",
      "'还没有批注。选中正文点「🖍 / 💬 / 💡」写下第一条。'")],
  ['卸载兜底丢失：detached 容器也照写',
    (s) => s.replace('if(!box || !document.body.contains(box)) return;', 'if(!box) return;')],
  ['闪烁不熄灭：少了 1200ms 摘 class',
    (s) => s.replace("setTimeout(()=>{ m.classList.remove('anno-flash'); }, 1200);", '')],
  ['跳页丢 Number()：page 以字符串传入翻页逻辑',
    (s) => s.replace('pdfGoToPage(pdfDoc, pdfTotal, pdfPagesEl, pdfBook, Number(a.page));',
      'pdfGoToPage(pdfDoc, pdfTotal, pdfPagesEl, pdfBook, a.page);')],
  ['标记找不到时抛错（丢掉静默兜底）',
    (s) => s.replace(/\n\s*if\(!m\) return;/, '')],
  ['Tab 切换不摘旧 active（两个 Tab 同时亮）',
    (s) => s.replace('tabs.forEach(t=> t.classList.toggle(\'active\', t === tab));', "tab.classList.add('active');")],
  ['筛选态不复原：重建 DOM 后硬回 all',
    (s) => s.replace("btn.classList.toggle('active', (btn.dataset.f || 'all') === pdfAnnoFilter);   // 复原上次筛选", '')],
  ['绑定时不算徽标：不点批注 Tab 就看不到条数',
    (s) => s.replace('  renderPdfAnnoList();   // 首次进入即算出 Tab 徽标数字', '  //')],
  ['renderPdfBook 忘了调用 bindPdfAnnoSidebar',
    (s) => s.replace('  bindPdfAnnoSidebar();                    // 侧栏', '  //')],
  ['删除按钮只删数据、不收尾（侧栏/正文失同步）',
    (s) => s.replace('dl.onclick = ()=>{ removeAnno(a.id); afterAnnoChange(a.bookId, a.page); toast("已删除"); };',
      'dl.onclick = ()=>{ removeAnno(a.id); toast("已删除"); };')],
  ['编辑按钮带错 id（永远编辑第一条）',
    (s) => s.replace('ed.onclick = ()=> openAnnoEditor({ annoId:a.id });', 'ed.onclick = ()=> openAnnoEditor({ annoId:list[0].id });')],
  ['软删批注仍被列出',
    (s) => s.replace('let list = annosOf(bookId, null);', 'let list = cogAnnos.filter(x=> x && x.bookId===bookId);')],
  ['移动端跳页后不收起浮层目录（挡住正文）',
    (s) => s.replace('if(window.matchMedia("(max-width:760px)").matches){ const toc = $("#pdfToc"); if(toc) toc.classList.remove(\'show\'); }', '')],
  ['批注 pane 默认就展开（一进阅读器不是目录）',
    (s) => s.replace('<div class="pdf-toc-pane" data-pane="anno" style="display:none;">', '<div class="pdf-toc-pane" data-pane="anno">')],
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-mut-'));
let killed = 0, survived = [], skipped = [];

for (const [name, fn] of MUTANTS) {
  const out = fn(SRC);
  if (out === SRC) { skipped.push(name); console.log(`SKIP  ${name}  ← 锚点未命中，变异体需更新`); continue; }
  const f = path.join(tmp, 'm.html');
  fs.writeFileSync(f, out);
  let dead = false;
  try {
    execFileSync(process.execPath, ['--test', TEST], {
      cwd: ROOT, env: { ...process.env, QA_TARGET_HTML: f }, stdio: 'pipe',
    });
  } catch { dead = true; }
  if (dead) { killed++; console.log(`KILL  ${name}`); }
  else { survived.push(name); console.log(`ALIVE ${name}  ← 测试盲区！`); }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n变异体 ${MUTANTS.length} 个：击杀 ${killed} / 存活 ${survived.length} / 跳过 ${skipped.length}`);
if (survived.length) { console.log('存活（需补测试）：\n  - ' + survived.join('\n  - ')); process.exit(1); }
if (skipped.length) process.exit(2);
