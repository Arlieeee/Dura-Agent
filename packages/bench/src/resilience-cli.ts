#!/usr/bin/env node
/** npm run bench:resilience —— 零 API 成本的故障注入对比,秒级出结果。 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runResilience, renderResilience } from './resilience.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const results = await runResilience();
const md = renderResilience(results);
console.log('\n' + md);

const outDir = path.resolve(HERE, '..', 'results');
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'resilience.md'), md, 'utf8');
console.log(`\n已写入 ${path.join(outDir, 'resilience.md')}`);

const failed = results.filter(r => r.harnessId === 'my-agent' && !r.passed);
if (failed.length) {
  console.error(`\n⚠ my-agent 有 ${failed.length} 项未通过 —— 这是框架自身的回归,不是对照组的问题`);
  process.exit(1);
}
