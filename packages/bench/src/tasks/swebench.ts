/** SWE-bench Lite —— 真实 GitHub issue 修复(300 题,princeton-nlp/SWE-bench_Lite)。
 *
 * 为什么非它不可:HumanEval 上四档 harness 落在 1.2pt 以内,不是因为题难度不够,
 * 是因为**题型不对** —— 单函数、无依赖、题面自带完整规格,一次就能写对,
 * 那正是"不加 harness"的最佳场景。换更难的单函数题(LiveCodeBench)只会让所有档一起掉分。
 *
 * SWE-bench 换的是题型:一个真实仓库、一段 issue 描述,要在几千个文件里定位问题、
 * 改代码、跑测试验证。**必须多轮、必须与环境交互** —— harness 的价值只在这种形状上体现。
 *
 * 判分照官方口径:
 *   FAIL_TO_PASS  修复前挂、修复后必须全过
 *   PASS_TO_PASS  修复前过、修复后不能挂(防"把测试删了"式作弊)
 *
 * 依赖 docker:每题一个官方镜像 swebench/sweb.eval.x86_64.<instance_id>,
 * 里面预装好了该仓库那个版本的完整环境(装依赖这件事本身就够写一篇了,官方替我们做完了)。
 * 代码在镜像自带的 /testbed 里,不是挂载的 —— 所以工作区必须用 ContainerWorkspace。
 * 没有 docker 时这个任务集为空,`npm run bench:doctor` 会说明原因。 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchTask } from '../types.js';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'SWE-bench_Lite.jsonl');

export interface SweRow {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;               // 参考解,只用于对照,不喂给 agent
  test_patch: string;          // 官方测试补丁,评测前打上
  FAIL_TO_PASS: string;        // JSON 数组字符串
  PASS_TO_PASS: string;
  version: string;
}

export const sweBenchAvailable = () => existsSync(DATA);

export function loadSwe(): SweRow[] {
  if (!existsSync(DATA)) return [];
  return readFileSync(DATA, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** 官方镜像命名规则(instance_id 里的双下划线要换成 _1776_,这是官方的转义约定) */
export const imageFor = (instanceId: string) =>
  `swebench/sweb.eval.x86_64.${instanceId.replace(/__/g, '_1776_')}:latest`;

const parseTests = (s: string): string[] => {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

/** 把 pytest 的输出解析成 {测试名 → 是否通过}。
 *  `-rA` 下两种行序都会出现:`test.py::name PASSED` 和 `PASSED test.py::name`,两种都认。 */
export function parsePytest(out: string): Map<string, boolean> {
  const res = new Map<string, boolean>();
  const STATUS = /^(PASSED|FAILED|ERROR)$/;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    const suffix = /^(\S+::\S+)\s+(\w+)/.exec(line);          // 名字在前
    const prefix = /^(\w+)\s+(\S+::\S+)/.exec(line);          // 状态在前
    if (suffix && STATUS.test(suffix[2])) res.set(suffix[1], suffix[2] === 'PASSED');
    else if (prefix && STATUS.test(prefix[1])) res.set(prefix[2], prefix[1] === 'PASSED');
  }
  return res;
}

export function sweBenchTasks(limit = 10): BenchTask[] {
  return loadSwe().slice(0, limit).map(row => {
    const f2p = parseTests(row.FAIL_TO_PASS);
    const p2p = parseTests(row.PASS_TO_PASS);

    return {
      id: `swe-${row.instance_id}`,
      category: 'software-engineering' as const,
      probe: `${row.repo} · 真实 issue 修复(F2P ${f2p.length} / P2P ${p2p.length})`,
      prompt: `仓库 ${row.repo} 里有一个待修复的问题。代码在 /testbed,已 checkout 到出问题的那个提交。

【issue】
${row.problem_statement.slice(0, 6000)}

请定位并修复它。要求:
- 只改产品代码,**不要动任何测试文件** —— 评测会用官方测试验证
- 改完可以用 bash 跑相关测试自查
- 不确定问题在哪就先检索(grep_files),别猜路径`,

      // 工作区由镜像提供(/testbed),不需要 bench 铺初始文件。
      // 这里放一份说明,让 setup 非空以通过任务集完整性检查,同时给 raw 档一点上下文。
      setup: { 'ISSUE.md': row.problem_statement.slice(0, 4000) },
      budget: { maxSteps: 30, timeoutMs: 900_000 },

      async check(ws) {
        // oracle 需要在容器里跑 pytest,这要求 runner 传进来的是 ContainerWorkspace。
        // bench 的 TaskWorkspace 是只读视图,拿不到 executor —— 所以真正的判分挂在
        // runner 侧(见 swebench-runner)。这里只做"agent 有没有乱动测试"的静态检查。
        const notes: string[] = [];
        const touched = (await ws.list()).filter(f => /test/i.test(f) && f.endsWith('.py'));
        if (touched.length) notes.push(`注意:工作区里有 ${touched.length} 个测试文件`);
        notes.push('SWE-bench 的判分需要在容器内跑 pytest,见 runSweEval()');
        return { completion: 0, notes };
      },
    };
  });
}

/** 容器内判分:打官方测试补丁 → 跑 F2P 与 P2P → 按官方口径给分。
 *  单独导出而不是塞进 task.check,是因为它需要 executor(在容器里跑命令),
 *  而 check 只拿得到只读的工作区视图。 */
export interface SweEvalResult { completion: number; notes: string[]; f2pPassed: number; p2pFailed: number }

export async function runSweEval(
  row: SweRow,
  exec: (cmd: string, timeoutMs?: number) => Promise<{ exit_code: number; stdout: string; stderr: string }>,
): Promise<SweEvalResult> {
  const f2p = parseTests(row.FAIL_TO_PASS);
  const p2p = parseTests(row.PASS_TO_PASS);
  const notes: string[] = [];

  // 1. 把测试文件恢复成官方版本,再打上 test_patch ——
  //    agent 可能改过测试(有意或无意),不恢复的话它可以靠改测试"通关"。
  const restore = await exec(`cd /testbed && git checkout -- $(git diff --name-only | grep -E 'test|tests' || true) 2>/dev/null; true`, 60_000);
  void restore;
  const apply = await exec(`cd /testbed && git apply -v - <<'PATCH_EOF'\n${row.test_patch}\nPATCH_EOF`, 120_000);
  if (apply.exit_code !== 0) {
    notes.push(`test_patch 应用失败:${(apply.stderr || apply.stdout).slice(0, 200)}`);
    return { completion: 0, notes, f2pPassed: 0, p2pFailed: p2p.length };
  }

  // 2. 跑 FAIL_TO_PASS:修好了就该全过
  const runTests = async (tests: string[]) => {
    if (!tests.length) return new Map<string, boolean>();
    const r = await exec(`cd /testbed && python -m pytest -rA --no-header -q ${tests.map(t => `'${t}'`).join(' ')} 2>&1 | tail -n 400`, 600_000);
    return parsePytest(r.stdout);
  };

  const f2pRes = await runTests(f2p);
  const f2pPassed = f2p.filter(t => f2pRes.get(t) === true).length;

  // 3. 跑 PASS_TO_PASS:本来就过的不许被改挂(防"删了碍事的断言"式作弊)
  const p2pRes = await runTests(p2p);
  const p2pFailed = p2p.filter(t => p2pRes.get(t) === false).length;

  notes.push(`FAIL_TO_PASS ${f2pPassed}/${f2p.length}`, `PASS_TO_PASS 回归 ${p2pFailed} 项`);

  // 官方口径是二元的:F2P 全过且 P2P 一个不挂,才算 resolved
  const resolved = f2p.length > 0 && f2pPassed === f2p.length && p2pFailed === 0;
  return {
    completion: resolved ? 1 : 0,
    notes: [...notes, resolved ? '✓ resolved' : '✗ unresolved'],
    f2pPassed, p2pFailed,
  };
}
