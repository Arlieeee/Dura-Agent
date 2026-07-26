/** HumanEval —— 真实公开 benchmark(OpenAI,164 题 Python 代码生成)。
 *
 * 接它进来不是为了刷榜,是因为它恰好把本项目最想问的那个问题摆在明面上:
 * **官方 pass@1 的评测方式就是"一次生成、不许迭代"** —— 那正是我们的 `raw` 档。
 * 而有 harness 的 agent 可以写文件 → 跑测试 → 看报错 → 改。
 * 同一批题、同一个模型,两种玩法的分差就是"能不能迭代"值多少分,
 * 而且这个数字可以直接对着公开 leaderboard 上的 pass@1 校准。
 *
 * 数据不进版本库:`node scripts/fetch-datasets.mjs humaneval`。
 * 拿不到数据时任务集为空,不影响其它题。 */
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchTask, TaskWorkspace } from '../types.js';

const run = promisify(execFile);
const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'HumanEval.jsonl');

interface HumanEvalRow { task_id: string; prompt: string; entry_point: string; test: string; canonical_solution: string }

export function humanEvalAvailable(): boolean { return existsSync(DATA); }

function load(): HumanEvalRow[] {
  if (!existsSync(DATA)) return [];
  return readFileSync(DATA, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** 找一个能用的 python。Windows 上 `python3` 常常不存在。 */
let cachedPy: string | null | undefined;
async function findPython(): Promise<string | null> {
  if (cachedPy !== undefined) return cachedPy;
  for (const cmd of [process.env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[]) {
    try { await run(cmd, ['-c', 'print(1)'], { timeout: 10_000 }); return (cachedPy = cmd); } catch { /* next */ }
  }
  return (cachedPy = null);
}

/** 官方判分程序:候选实现 + 官方测试 + check(entry_point)。 */
async function runHarness(ws: TaskWorkspace, row: HumanEvalRow, solution: string): Promise<{ pass: boolean; err: string }> {
  const py = await findPython();
  if (!py) return { pass: false, err: '找不到 python(设 PYTHON_BIN)' };
  const program = `${solution}\n\n${row.test}\n\ncheck(${row.entry_point})\nprint("__HE_OK__")\n`;
  const file = path.join(ws.root, '__he_check.py');
  const { writeFile, rm } = await import('node:fs/promises');
  await writeFile(file, program, 'utf8');
  try {
    // 跑的是模型生成的代码。已经在一次性临时目录里,再加超时兜底。
    const { stdout } = await run(py, [file], { cwd: ws.root, timeout: 20_000, maxBuffer: 1 << 20 });
    return { pass: stdout.includes('__HE_OK__'), err: '' };
  } catch (err: any) {
    const msg = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n');
    return { pass: false, err: msg.split('\n').filter((l: string) => l.trim()).slice(-3).join(' | ').slice(0, 220) };
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

/** 取前 n 题(题目自带难度梯度,顺序取即可保证可复现) */
export function humanEvalTasks(limit = 20): BenchTask[] {
  return load().slice(0, limit).map(row => {
    const num = row.task_id.split('/')[1];
    return {
      id: `humaneval-${String(num).padStart(3, '0')}`,
      category: 'software-engineering' as const,
      probe: `HumanEval/${num} · ${row.entry_point}`,
      prompt: `在 solution.py 里补全下面这个函数,使它满足 docstring 的描述。
保留原有的 import 与函数签名,只补实现。不要写测试,不要改函数名。

\`\`\`python
${row.prompt}\`\`\`

写完后如果有 bash 工具,可以自己写几个例子跑一下验证。`,
      // 只给函数签名与 docstring —— 和官方 pass@1 的输入完全一致
      setup: { 'solution.py': row.prompt },
      async check(ws) {
        if (!await ws.exists('solution.py')) return { completion: 0, notes: ['solution.py 不存在'] };
        const solution = await ws.read('solution.py');
        if (!new RegExp(`def\\s+${row.entry_point}\\b`).test(solution)) {
          return { completion: 0, notes: [`solution.py 里找不到 def ${row.entry_point}`] };
        }
        const r = await runHarness(ws, row, solution);
        return r.pass
          ? { completion: 1, notes: ['官方测试通过 ✓'] }
          : { completion: 0, notes: [`官方测试未通过:${r.err}`] };   // pass@1 是二元的,不给部分分
      },
    };
  });
}
