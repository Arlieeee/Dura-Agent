#!/usr/bin/env node
/** 从已有的 run-*.json 重新生成报告。改了 report.ts 又不想重花一次 API 钱时用。
 *   npm run bench:regen -w packages/bench -- results/run-A.json [results/run-B.json ...]
 *
 * 传多个文件时按顺序合并,后面的覆盖前面的同 (task, harness, model, rep) 记录。
 * 用途:只重跑了某一档(比如修了它的 token 统计口径),把新结果并回整场跑分,
 * 不必为一档的修正把 400 格全重来一遍。 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReport, registerProbes } from './report.js';
import { allTasks } from './tasks/index.js';
import { rawHarness } from './harness/raw.js';
import { reactMinHarness } from './harness/react-min.js';
import { myAgentHarness } from './harness/my-agent.js';
import { piHarness } from './harness/pi.js';
import type { Harness } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL: Harness[] = [rawHarness, reactMinHarness, myAgentHarness, piHarness];

const srcs = process.argv.slice(2);
if (!srcs.length) { console.error('用法: bench:regen <run-*.json> [更多 run-*.json ...]'); process.exit(1); }

const merged = new Map<string, any>();
let meta: any;
for (const src of srcs) {
  const raw = JSON.parse(await readFile(path.resolve(src), 'utf8'));
  meta ??= raw.meta;
  meta.models = [...new Set([...(meta.models ?? []), ...(raw.meta.models ?? [])])];
  for (const r of raw.records) merged.set(`${r.taskId}|${r.harnessId}|${r.model}|${r.rep ?? 0}`, r);
  console.log(`并入 ${path.basename(src)}:${raw.records.length} 格 → 累计 ${merged.size}`);
}
const records = [...merged.values()];
registerProbes(allTasks);

// 只渲染结果里真实出现过的 harness,顺序沿用 ALL
const present = ALL.filter(h => records.some((r: any) => r.harnessId === h.id));
const md = renderReport(records, present, {
  model: meta.models, budget: meta.budget, startedAt: meta.startedAt, wallMs: meta.wallMs,
});

const outDir = path.resolve(HERE, '..', 'results');
await writeFile(path.join(outDir, 'latest.md'), md, 'utf8');
console.log(md);
console.log(`\n已重写 ${path.join(outDir, 'latest.md')}`);
