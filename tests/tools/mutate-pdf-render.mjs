/**
 * 变异测试：往 workbench.html 的副本里注入「改动前的老缺陷」，
 * 再用同一套测试去跑。若测试仍然全绿，说明测试是摆设。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'workbench.html'), 'utf8');

const MUTANTS = [
  {
    id: 'M1 渲染退回逻辑 viewport（= 修复前的模糊 bug）',
    apply: (s) => s.replaceAll('viewport: rVp }', 'viewport: lVp }'),
  },
  {
    id: 'M2 文字层误用物理 viewport（高亮/选中整体偏移 dpr 倍）',
    apply: (s) => s.replaceAll('buildTextLayer(textContent, lVp)', 'buildTextLayer(textContent, rVp)'),
  },
  {
    id: 'M3 canvas 位图尺寸退回逻辑尺寸（等于没做高清）',
    apply: (s) => s.replaceAll('canvas.width = Math.floor(rVp.width); canvas.height = Math.floor(rVp.height);',
                               'canvas.width = Math.floor(lVp.width); canvas.height = Math.floor(lVp.height);'),
  },
  {
    id: 'M4 canvas CSS 尺寸误用物理尺寸（页面被撑爆 dpr 倍）',
    apply: (s) => s.replaceAll("canvas.style.width = Math.floor(lVp.width)+'px'; canvas.style.height = Math.floor(lVp.height)+'px';",
                               "canvas.style.width = Math.floor(rVp.width)+'px'; canvas.style.height = Math.floor(rVp.height)+'px';"),
  },
  {
    id: 'M5 移除 canvas 面积上限保护（4K+300% 会分配失败白页）',
    apply: (s) => s.replace('if(w * h * r * r > PDF_MAX_CANVAS_PX) r = Math.sqrt(PDF_MAX_CANVAS_PX / (w * h));', ''),
  },
  {
    id: 'M6 移除 canvas 单边上限保护',
    apply: (s) => s.replace('if(r > sideCap) r = sideCap;', ''),
  },
  {
    id: 'M7 移除 _pdfResizeBound 守卫（每次开书重复绑 window 监听）',
    apply: (s) => s.replace('if(_pdfResizeBound) return;', ''),
  },
  {
    id: 'M8 回收时不再豁免可见页 / 当前页（眼前的页会变白）',
    apply: (s) => s.replace('.filter(n => !pdfVisible.has(n) && n !== pdfCurrentPage)', '.filter(n => true)'),
  },
  {
    id: 'M9 重渲染时不清除回收冻结的高度（重排后高度错乱）',
    apply: (s) => s.replace("slot.style.minHeight = '';               // 清掉回收时冻结的高度，交回内容撑开", ''),
  },
  {
    id: 'M10 fit-to-width 被写死为固定 scale（丢失多端自适应）',
    apply: (s) => s.replace('pdfFitScale = Math.min(6, Math.max(0.1, cw / base.width));', 'pdfFitScale = 1.4;'),
  },
  {
    id: 'M11 debounce 从 200ms 改成 0（resize 抖动风暴）',
    apply: (s) => s.replace('setTimeout(onPdfViewportResize, 200)', 'setTimeout(onPdfViewportResize, 0)'),
  },
  {
    id: 'M12 index.html 与 workbench.html 不同步',
    applyIndex: true,
  },
];

const tmp = path.join(ROOT, '.qa-tmp');
let killed = 0, survived = [];

for (const m of MUTANTS) {
  let targetEnv = {};
  if (m.applyIndex) {
    // 篡改 index.html 副本无法通过 env 切换，改为直接构造一个「与 index 不同」的 workbench 副本
    const f = path.join(tmp, 'mut12.html');
    fs.writeFileSync(f, SRC + '\n<!-- drift -->');
    targetEnv = { QA_TARGET_HTML: f };
  } else {
    const out = m.apply(SRC);
    if (out === SRC) { survived.push(m.id + '  ⚠ 变异未生效（匹配失败）'); continue; }
    const f = path.join(tmp, 'mut.html');
    fs.writeFileSync(f, out);
    targetEnv = { QA_TARGET_HTML: f };
  }
  let failed = 0, out = '';
  try {
    out = execFileSync(process.execPath, ['--test', 'tests/pdf-render.test.mjs'],
      { cwd: ROOT, env: { ...process.env, ...targetEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const mm = out.match(/^# fail (\d+)$/m);
  failed = mm ? Number(mm[1]) : -1;
  if (failed > 0) { killed++; console.log(`KILLED  (${String(failed).padStart(2)} 个用例失败)  ${m.id}`); }
  else { survived.push(m.id); console.log(`SURVIVED  ⚠⚠  ${m.id}`); }
}

console.log('\n──────────────────────────────');
console.log(`变异被杀死: ${killed}/${MUTANTS.length}`);
if (survived.length) { console.log('存活（测试盲区）:'); survived.forEach((s) => console.log('  - ' + s)); }
else console.log('全部变异均被测试捕获 —— 测试具备真实杀伤力');
