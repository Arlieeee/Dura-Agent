#!/usr/bin/env node
/** bench CLI。
 *   npm run bench                              # 全量三档对照
 *   npm run bench -- --tasks edit-01,data-01   # 挑题(支持 id 前缀与 category)
 *   npm run bench -- --harness raw,my-agent    # 挑档
 *   npm run bench -- --models deepseek-flash,deepseek-v4-pro
 *   npm run bench -- --steps 8 --timeout 120 --concurrency 4 --traces
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from '../../../apps/server/src/env.js';
import { runBench, DEFAULT_BUDGET } from './runner.js';
import { selectTasks, allTasks } from './tasks/index.js';
import { rawHarness } from './harness/raw.js';
import { reactMinHarness } from './harness/react-min.js';
import { myAgentHarness } from './harness/my-agent.js';
import { piHarness, piAvailable } from './harness/pi.js';
import { renderReport, registerProbes } from './report.js';
import { benchModels } from './provider.js';
import type { Harness } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL_HARNESSES: Harness[] = [rawHarness, reactMinHarness, myAgentHarness, piHarness];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  loadLocalEnv();
  process.env.BENCH_RUN_SALT ??= `[bench ${Math.random().toString(36).slice(2, 10)}]`;
  const tasks = selectTasks(arg('tasks'));
  if (!tasks.length) {
    console.error(`没有匹配的任务。可用:\n${allTasks.map(t => `  ${t.id.padEnd(32)} ${t.category}`).join('\n')}`);
    process.exit(1);
  }
  const hFilter = arg('harness')?.split(',').map(s => s.trim());
  let harnesses = hFilter ? ALL_HARNESSES.filter(h => hFilter.includes(h.id)) : ALL_HARNESSES;
  if (!harnesses.length) { console.error(`没有匹配的 harness。可用:${ALL_HARNESSES.map(h => h.id).join(', ')}`); process.exit(1); }
  // Pi 是可选依赖:没装就跳过,别让第四档拖垮整场跑分
  if (harnesses.some(h => h.id === 'pi') && !await piAvailable()) {
    console.warn('⚠ 未安装 @earendil-works/pi-agent-core,跳过 pi 档(npm i -w packages/bench --save-optional @earendil-works/pi-agent-core @earendil-works/pi-ai)');
    harnesses = harnesses.filter(h => h.id !== 'pi');
  }

  const models = arg('models')?.split(',').map(s => s.trim()) ?? benchModels();
  const budget = {
    maxSteps: Number(arg('steps') ?? DEFAULT_BUDGET.maxSteps),
    timeoutMs: Number(arg('timeout') ?? DEFAULT_BUDGET.timeoutMs / 1000) * 1000,
  };
  const concurrency = Number(arg('concurrency') ?? 3);
  const repeat = Number(arg('repeat') ?? 1);

  // 工具面对 raw 之外的两档必须完全一致,才叫控变量。
  // bash 默认开:真实 coding agent 都有执行能力,关掉等于把"跑测试看反馈"这条路堵死。
  // --no-bash 做消融实验:同一 harness 同一模型,只砍执行能力,看掉多少分。
  process.env.TOOLSET = 'coding';
  process.env.ENABLE_BASH = flag('no-bash') ? '0' : '1';
  if (flag('no-subagents')) process.env.BENCH_SUBAGENTS = '0';

  registerProbes(tasks);
  const total = tasks.length * harnesses.length * models.length * repeat;
  console.log(`\n跑 ${tasks.length} 题 × ${harnesses.length} harness × ${models.length} 模型 × ${repeat} 次 = ${total} 格`);
  console.log(`预算 maxSteps=${budget.maxSteps} timeout=${budget.timeoutMs / 1000}s · 并发 ${concurrency}`);
  console.log(`harness: ${harnesses.map(h => h.id).join(', ')}`);
  console.log(`模型: ${models.join(', ')} · bash=${process.env.ENABLE_BASH === '1' ? 'on' : 'off'}`
    + ` · subagent=${process.env.BENCH_SUBAGENTS === '0' ? 'off' : 'on'}\n`);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const records = await runBench({
    tasks, harnesses, models, budget, concurrency, repeat,
    keepTraces: flag('traces'),
    onProgress: msg => console.log(msg),
  });
  const wallMs = Date.now() - t0;

  const outDir = path.resolve(HERE, '..', 'results');
  await mkdir(outDir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = path.join(outDir, `run-${stamp}.json`);
  const mdPath = path.join(outDir, `report-${stamp}.md`);

  await writeFile(jsonPath, JSON.stringify({ meta: { startedAt, wallMs, models, budget }, records }, null, 2), 'utf8');
  const md = renderReport(records, harnesses, { model: models, budget, startedAt, wallMs });
  await writeFile(mdPath, md, 'utf8');
  await writeFile(path.join(outDir, 'latest.md'), md, 'utf8');

  console.log('\n' + md.split('## 分类得分')[0]);
  console.log(`\n完整报告 → ${mdPath}\n原始结果 → ${jsonPath}`);
}

main().catch(err => { console.error('\nbench 失败:', err); process.exit(1); });
