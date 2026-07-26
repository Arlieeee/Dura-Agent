#!/usr/bin/env node
/** npm run bench:doctor —— 一条命令看清这台机器能跑哪些评测。
 *
 * 存在的理由:这套 bench 的依赖是分层的(有的题只要 node,有的要 python,SWE-bench 要 docker),
 * 缺哪一层就少跑哪一批题。与其让人对着一堆超时和 0 分猜原因,不如开跑前先把话说清楚。
 * 换到云端容器上第一件事就该跑它。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from '../../../apps/server/src/env.js';
import { dockerAvailable } from '../../../apps/server/src/executor.js';
import { findShell } from '../../../apps/server/src/tools/bash.js';
import { humanEvalAvailable } from './tasks/humaneval.js';
import { sweBenchAvailable } from './tasks/swebench.js';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

interface Check { name: string; ok: boolean; detail: string; blocks: string }

async function version(cmd: string, args: string[]): Promise<string | null> {
  try { const { stdout, stderr } = await run(cmd, args, { timeout: 15_000 }); return (stdout || stderr).trim().split('\n')[0]; }
  catch { return null; }
}

loadLocalEnv();
const checks: Check[] = [];

/* --- 基础:没它什么都跑不了 --- */
checks.push({ name: 'node', ok: true, detail: process.version, blocks: '' });

const shell = findShell();
checks.push({
  name: 'bash', ok: !!shell,
  detail: shell ?? '找不到(Windows 需 Git Bash,或设 BASH_PATH)',
  blocks: shell ? '' : '所有需要执行命令的题(hard-01、bug-*)',
});

/* --- API key:没它只能跑韧性评测 --- */
const key = process.env.PROVIDER_API_KEY ?? process.env.DS_API_KEY;
checks.push({
  name: 'API key', ok: !!key,
  detail: key ? `已配置(${key.slice(0, 6)}…,长度 ${key.length})` : '缺 DS_API_KEY / PROVIDER_API_KEY',
  blocks: key ? '' : '全部跑分(bench:resilience 不受影响)',
});

/* --- python:HumanEval 的判分要它 --- */
const py = await version(process.env.PYTHON_BIN ?? 'python3', ['--version']) ?? await version('python', ['--version']);
checks.push({
  name: 'python', ok: !!py,
  detail: py ?? '找不到(设 PYTHON_BIN)',
  blocks: py ? '' : 'HumanEval(判分要跑 python)',
});

/* --- docker:真沙箱与 SWE-bench 类评测的前提 --- */
const dk = await dockerAvailable();
checks.push({
  name: 'docker', ok: dk.ok,
  detail: dk.ok ? `daemon 就绪(${dk.detail})` : `不可用:${dk.detail}`,
  blocks: dk.ok ? '' : 'SANDBOX=docker 会静默退回 local;需要真隔离的评测跑不了',
});

/* --- 数据集 --- */
checks.push({
  name: 'HumanEval 数据', ok: humanEvalAvailable(),
  detail: humanEvalAvailable() ? 'data/HumanEval.jsonl 就位' : '未下载',
  blocks: humanEvalAvailable() ? '' : '--tasks humaneval(跑 node scripts/fetch-datasets.mjs humaneval)',
});

checks.push({
  name: 'SWE-bench 数据', ok: sweBenchAvailable(),
  detail: sweBenchAvailable() ? 'data/SWE-bench_Lite.jsonl 就位(300 题)' : '未下载',
  blocks: sweBenchAvailable() ? '' : '--tasks swebench(跑 node scripts/fetch-datasets.mjs swebench)',
});

/* --- 可选的第三方 harness --- */
const piOk = existsSync(path.resolve(HERE, '..', '..', '..', 'node_modules', '@earendil-works', 'pi-agent-core'));
checks.push({
  name: 'Pi harness', ok: piOk,
  detail: piOk ? '@earendil-works/pi-agent-core 已安装' : '未安装(可选依赖)',
  blocks: piOk ? '' : 'pi 档会被自动跳过',
});

/* --- 输出 --- */
console.log('\n环境自检\n');
const pad = Math.max(...checks.map(c => c.name.length));
for (const c of checks) {
  console.log(`  ${c.ok ? '✅' : '⚠️ '} ${c.name.padEnd(pad)}  ${c.detail}`);
  if (!c.ok && c.blocks) console.log(`     ${' '.repeat(pad)}  └─ 影响:${c.blocks}`);
}

const blocked = checks.filter(c => !c.ok);
console.log(blocked.length
  ? `\n${blocked.length} 项未就绪 —— 上面列了各自影响哪些题,不影响的部分照常跑。\n`
  : '\n全部就绪:自建题 / HumanEval / docker 沙箱都能跑。\n');

// 缺项不算失败:这条命令是用来"看清状况"的,不是门禁。CI 里也能安全地跑。
