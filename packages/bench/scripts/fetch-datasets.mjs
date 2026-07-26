#!/usr/bin/env node
/** 拉取公开评测数据集到 packages/bench/data/。
 *
 * 数据集不进版本库(体积 + 出处应当保持单一真相),用这个脚本按需下载。
 *   node scripts/fetch-datasets.mjs            # 全部
 *   node scripts/fetch-datasets.mjs humaneval  # 指定 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const SETS = {
  humaneval: {
    file: 'HumanEval.jsonl',
    url: 'https://github.com/openai/human-eval/raw/master/data/HumanEval.jsonl.gz',
    gzip: true,
    note: 'OpenAI HumanEval,164 题 Python 代码生成(MIT)',
  },
  swebench: {
    file: 'SWE-bench_Lite.jsonl',
    rows: { dataset: 'princeton-nlp/SWE-bench_Lite', config: 'default', split: 'test' },
    note: 'SWE-bench Lite,300 道真实 GitHub issue(判分需 docker)',
  },
};

/** HuggingFace rows API 一次最多 100 行,分页拉全 */
async function fetchRows({ dataset, config, split }) {
  const base = 'https://datasets-server.huggingface.co/rows';
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const u = `${base}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=100`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    out.push(...(j.rows ?? []).map(r => r.row));
    if (out.length >= (j.num_rows_total ?? 0) || !j.rows?.length) break;
    process.stdout.write('.');
  }
  return out;
}

const want = process.argv.slice(2);
await mkdir(DATA_DIR, { recursive: true });

for (const [name, s] of Object.entries(SETS)) {
  if (want.length && !want.includes(name)) continue;
  const dest = path.join(DATA_DIR, s.file);
  if (await stat(dest).then(() => true).catch(() => false)) {
    console.log(`✓ ${name} 已存在,跳过(${s.file})`);
    continue;
  }
  process.stdout.write(`↓ ${name}:${s.note} … `);
  if (s.rows) {
    const rows = await fetchRows(s.rows);
    const jsonl = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(dest, jsonl, 'utf8');
    console.log(` ${rows.length} 行 → data/${s.file}`);
    continue;
  }
  const res = await fetch(s.url, { redirect: 'follow' });
  if (!res.ok) { console.error(`失败 HTTP ${res.status}`); process.exitCode = 1; continue; }
  const raw = Buffer.from(await res.arrayBuffer());
  const out = s.gzip ? await buffer(Readable.from(raw).pipe(createGunzip())) : raw;
  await writeFile(dest, out);
  console.log(`${(out.length / 1024).toFixed(0)} KB → data/${s.file}`);
}
