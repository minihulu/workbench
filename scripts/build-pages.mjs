#!/usr/bin/env node
/**
 * Cloudflare Pages 静态产物构建脚本。
 *
 * 单一真相：`workbench.html` 是唯一维护的前端源文件。
 * `_site/index.html` 由本脚本在**构建时**生成，仓库里不保留重复副本
 * —— 历史上那份手工维护的 index.html 副本导致过严重的「改了没生效」事故。
 *
 * 幂等：可重复运行，每次先清空 _site/。
 *
 * 用法：npm run build:pages
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_site');

/** 前端主文件 → _site/index.html */
const ENTRY = 'workbench.html';

/** 一并复制的静态资源（缺失则跳过并告警，不让构建失败） */
const ASSETS = ['icon.png', 'icon.ico', '32x32.png', '128x128.png', '128x128@2x.png'];

async function main() {
  const entryPath = join(ROOT, ENTRY);
  if (!existsSync(entryPath)) {
    console.error(`[build:pages] 找不到入口文件 ${ENTRY}，构建中止`);
    process.exit(1);
  }

  // 幂等：只做「建目录 + 覆盖写」，不递归删除。
  // CI（Cloudflare Pages）每次都是干净 checkout，不需要清理；本地重复跑时
  // 覆盖同名文件即可，避免 rm -rf 在各种受限环境下失败拖垮构建。
  await mkdir(OUT, { recursive: true });

  // 用 readFile + writeFile 而不是 cp：writeFile 是「截断覆盖」，
  // 不涉及 unlink，在各种受限 / 只读回收站环境下都不会失败。
  const html = await readFile(entryPath);
  await writeFile(join(OUT, 'index.html'), html);
  const entrySize = (await stat(entryPath)).size;
  console.log(`[build:pages] ${ENTRY} -> _site/index.html (${entrySize} bytes)`);

  // 有意**不**再输出一份 _site/workbench.html：
  // 「同一份前端存在两个可访问副本」正是历史上「改了没生效」事故的根源，
  // 线上只留 /（index.html）这一个入口。
  let copied = 0;
  for (const name of ASSETS) {
    const src = join(ROOT, name);
    if (!existsSync(src)) {
      console.warn(`[build:pages] 跳过缺失的静态资源: ${name}`);
      continue;
    }
    await writeFile(join(OUT, name), await readFile(src));
    copied++;
  }
  console.log(`[build:pages] 复制静态资源 ${copied}/${ASSETS.length} 个`);

  // Pages 默认给所有静态资源加长缓存；HTML 必须禁缓存，
  // 否则前端改了用户端还是老版本（对齐 server.py serve_static 的 no-store）。
  await writeFile(
    join(OUT, '_headers'),
    [
      '/',
      '  Cache-Control: no-store, no-cache, must-revalidate, max-age=0',
      '/index.html',
      '  Cache-Control: no-store, no-cache, must-revalidate, max-age=0',
      '',
    ].join('\n'),
    'utf8',
  );
  console.log('[build:pages] 写入 _site/_headers（HTML 禁缓存）');
  console.log('[build:pages] 完成 → _site/');
}

main().catch((e) => {
  console.error('[build:pages] 失败:', e);
  process.exit(1);
});
