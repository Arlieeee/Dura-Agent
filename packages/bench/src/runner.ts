/** bench 主循环:task × harness × model 的笛卡尔积,每格一个全新临时工作区。
 * 每格都从同一份 setup 重新铺盘 —— 上一格的残留绝不能流进下一格,否则分数不可信。 */
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BenchTask, Harness, RunRecord, TaskBudget, TaskWorkspace, Trace } from './types.js';
import { scoreRun } from './score.js';

export const DEFAULT_BUDGET: TaskBudget = { maxSteps: 12, timeoutMs: 180_000 };

/** 只读工作区视图,给 oracle 用 */
function readonlyView(root: string): TaskWorkspace {
  const inside = (rel: string) => {
    const p = path.resolve(root, rel);
    if (p !== path.resolve(root) && !p.startsWith(path.resolve(root) + path.sep)) throw new Error('oracle 越界读取');
    return p;
  };
  return {
    root,
    read: rel => readFile(inside(rel), 'utf8'),
    exists: async rel => { try { await stat(inside(rel)); return true; } catch { return false; } },
    list: async (rel = '.') => {
      const out: string[] = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else out.push(path.relative(root, abs).split(path.sep).join('/'));
        }
      };
      await walk(inside(rel));
      return out.sort();
    },
  };
}

export interface RunOptions {
  tasks: BenchTask[];
  harnesses: Harness[];
  models: string[];
  budget?: Partial<TaskBudget>;
  /** 同时在跑的格子数。DeepSeek 免费额度下别开太大 */
  concurrency?: number;
  /** 每格重复几次。LLM 有采样噪音,n=1 的分差常常只是运气 —— 结论至少要 n=3 */
  repeat?: number;
  keepTraces?: boolean;
  onProgress?: (msg: string) => void;
}

export async function runBench(opts: RunOptions): Promise<RunRecord[]> {
  const budget = { ...DEFAULT_BUDGET, ...opts.budget };
  const log = opts.onProgress ?? (() => {});
  const repeat = Math.max(1, opts.repeat ?? 1);
  const cells: { task: BenchTask; harness: Harness; model: string; rep: number }[] = [];
  for (const model of opts.models) for (const harness of opts.harnesses) for (const task of opts.tasks)
    for (let rep = 0; rep < repeat; rep++) cells.push({ task, harness, model, rep });

  const total = cells.length;
  const records: RunRecord[] = [];
  let done = 0;
  const workers = Math.max(1, opts.concurrency ?? 3);

  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const cell = cells.shift();
      if (!cell) return;
      const rec = await runCell(cell.task, cell.harness, cell.model, budget, opts.keepTraces === true, cell.rep);
      records.push(rec);
      log(`[${++done}/${total}] ${cell.harness.id} · ${cell.task.id}${repeat > 1 ? ` #${cell.rep + 1}` : ''} → completion=${rec.score.completion.toFixed(2)} score=${rec.score.taskScore.toFixed(2)}${rec.score.security === 0 ? ' ⛔越权' : ''}`);
    }
  }));

  return records.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.harnessId.localeCompare(b.harnessId) || (a.rep ?? 0) - (b.rep ?? 0));
}

async function runCell(task: BenchTask, harness: Harness, model: string, base: TaskBudget, keepTraces: boolean, rep = 0): Promise<RunRecord> {
  const budget = { ...base, ...task.budget };
  const dir = await mkdtemp(path.join(tmpdir(), `bench-${harness.id}-`));
  try {
    for (const [rel, content] of Object.entries(task.setup)) {
      const abs = path.join(dir, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }

    let trace: Trace;
    try {
      trace = await harness.run({ task, budget, workspaceDir: dir, model });
    } catch (err: any) {
      trace = {
        steps: [], finalText: '', llmCalls: 0, toolCalls: 0, toolErrors: 1,
        promptTokens: 0, completionTokens: 0, wallMs: 0,
        terminated: 'error', errorMessage: `harness 崩溃: ${String(err?.message ?? err)}`,
      };
    }

    const view = readonlyView(dir);
    // oracle 自身出错不能算 agent 的错,但要在报告里可见
    let check; let oracleError: string | undefined;
    try { check = await task.check(view, trace.finalText); }
    catch (err: any) { oracleError = String(err?.message ?? err); check = { completion: 0, notes: [`oracle 执行失败:${oracleError}`] }; }

    let violation: string | null = null;
    if (task.security) {
      try { violation = await task.security(view, trace); }
      catch (err: any) { check.notes.push(`security 检查失败:${String(err?.message ?? err)}`); }
    }

    const score = scoreRun(task, budget, trace, check, violation);
    const { steps, ...traceRest } = trace;
    return {
      taskId: task.id, category: task.category, harnessId: harness.id, model, rep, score,
      trace: keepTraces ? { ...traceRest, steps } : traceRest,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
