/**
 * gen-ecdict-shards.mjs
 * ---------------------------------------------------------------------------
 * 从完整 ECDICT CSV 生成「按首字母分片、懒加载」的静态词典资源。
 *
 * 设计目标：
 *  - 让查词功能全量离线可用（约 70 万+ 词条），同时网页首屏不加载整本词典；
 *  - 每个首字母一个分片文件 vendor/ecdict/<letter>.js（'#' 类归入 vendor/ecdict/_.js）；
 *  - 分片文件极小、无空格，浏览器按需 <script> 注入，注入后挂到 window.ECDICT。
 *
 * 用法：
 *  node scripts/gen-ecdict-shards.mjs [path-to-ecdict.csv]
 *      - 不传参则默认读取仓库根目录的 ecdict_full.csv（可用环境变量 ECDICT_CSV 覆盖）。
 *  - 必须先下载完整 CSV（约 50MB，MIT 协议）：
 *      curl -s -L -x http://127.0.0.1:7890 -o ecdict_full.csv \
 *        https://raw.githubusercontent.com/fendaq/ECDICT/master/ecdict.csv
 *    （本环境走代理；该 CSV 不入库，仅提交分片产物与本脚本。）
 *
 * 字段（ECDICT）：
 *  word,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio
 *
 * 输出格式（压缩、无空格）：
 *  (function(){if(!window.ECDICT)window.ECDICT={};Object.assign(window.ECDICT,{"apple":{"phonetic":"...","pos":"n.","meaning":"..."}});})();
 *
 * 归一化键规则（与前端 lookupWord 一致）：小写、去标点/数字/空格，保留纯字母。
 * 首字母分片键：取 word 中第一个匹配 /[a-z]/i 的字符并小写；无字母归入 '#'。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** 解析 CSV 路径：命令行参数 > 环境变量 > 默认仓库根目录/ecdict_full.csv */
function resolveCsvPath() {
  const arg = process.argv[2];
  if (arg) return path.resolve(process.cwd(), arg);
  const env = process.env.ECDICT_CSV;
  if (env) return path.resolve(env);
  return path.join(REPO_ROOT, 'ecdict_full.csv');
}

/** 与前端 normalizeWord 完全一致：小写、去标点/数字/空格，保留纯字母。 */
function normalizeWord(w) {
  return (w || '').toLowerCase().trim().replace(/[^a-z]/g, '');
}

/** 分片键：第一个英文字母（小写），无字母归 '#'。 */
function shardKeyOf(w) {
  const m = (w || '').toLowerCase().match(/[a-z]/);
  return m ? m[0] : '#';
}

/**
 * 稳健 CSV 解析器：支持引号内换行、转义引号（""）、逗号，兼容 CRLF/LF。
 * 返回二维数组 rows（不含对调用方隐藏的额外处理，首行即表头）。
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      // 忽略 CR，由随后的 \n 决定换行
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // 处理末尾未以换行结束的最后一段
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function main() {
  const csvPath = resolveCsvPath();
  if (!fs.existsSync(csvPath)) {
    console.error(`[gen-ecdict-shards] 找不到 CSV 文件：${csvPath}`);
    console.error('请先下载完整 ECDICT CSV（见脚本头注释），或传入路径作为参数。');
    process.exit(1);
  }

  console.log(`[gen-ecdict-shards] 读取 CSV：${csvPath}`);
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);
  console.log(`[gen-ecdict-shards] 解析得到 ${rows.length} 行（含表头）`);

  if (rows.length < 2) {
    console.error('[gen-ecdict-shards] CSV 行数异常，可能解析失败。');
    process.exit(1);
  }

  // 按首字母聚合：shards['a'] = { key: {phonetic,pos,meaning}, ... }
  const shards = Object.create(null);
  for (let r = 1; r < rows.length; r++) {
    const cols = rows[r];
    const word = cols[0] || '';
    if (!word.trim()) continue; // 空 word 跳过

    const phonetic = cols[1] || '';
    const definition = cols[2] || '';
    const translation = cols[3] || '';
    const pos = cols[4] || '';

    const meaning =
      (translation && translation.trim()) ||
      (definition && definition.trim()) ||
      '';

    const key = normalizeWord(word);
    if (!key) continue; // 归一化后为空（纯数字/符号），查词键也匹配不到，跳过

    const letter = shardKeyOf(word);
    if (!shards[letter]) shards[letter] = Object.create(null);
    // 同键后者覆盖前者（如 don't 与 dont），保证一个键一条目
    shards[letter][key] = {
      phonetic: phonetic || '',
      pos: pos || '',
      meaning: meaning || '',
    };
  }

  const outDir = path.join(REPO_ROOT, 'vendor', 'ecdict');
  fs.mkdirSync(outDir, { recursive: true });

  let total = 0;
  const letters = Object.keys(shards).sort();
  for (const letter of letters) {
    const obj = shards[letter];
    const count = Object.keys(obj).length;
    total += count;
    const fileName = letter === '#' ? '_' : letter;
    const content =
      '(function(){if(!window.ECDICT)window.ECDICT={};' +
      'Object.assign(window.ECDICT,' +
      JSON.stringify(obj) +
      ');})();';
    const outPath = path.join(outDir, `${fileName}.js`);
    fs.writeFileSync(outPath, content);
    const bytes = Buffer.byteLength(content, 'utf8');
    console.log(
      `[gen-ecdict-shards] vendor/ecdict/${fileName}.js  词条=${count}  体积=${(bytes / 1024).toFixed(1)}KB`
    );
  }

  if (letters.length === 0) {
    console.warn('[gen-ecdict-shards] 未生成任何分片（输入可能为空）。');
  }

  console.log('────────────────────────────────────────────');
  console.log(`[gen-ecdict-shards] 分片数：${letters.length}（${letters.join('')}）`);
  console.log(`[gen-ecdict-shards] 总词条数：${total}`);
  console.log('[gen-ecdict-shards] 完成。');
}

main();
