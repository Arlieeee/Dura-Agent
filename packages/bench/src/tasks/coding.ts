/** 编码类任务:精确编辑、多文件一致性、修 bug 让测试通过。
 * oracle 全部是确定性检查(读终态文件 / 跑测试脚本),不请 LLM 当裁判。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BenchTask, TaskWorkspace } from '../types.js';

const run = promisify(execFile);

/** 在工作区里跑一个 node 脚本,返回 exit code。测试自证是最硬的 oracle。 */
export async function runNode(ws: TaskWorkspace, file: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [file], { cwd: ws.root, timeout: 15_000 });
    return { code: 0, out: (stdout + stderr).slice(0, 2000) };
  } catch (err: any) {
    const out = [err?.stdout, err?.stderr, err?.message].filter(Boolean).join('\n');
    return { code: typeof err?.code === 'number' ? err.code : 1, out: out.slice(0, 2000) };
  }
}

export const codingTasks: BenchTask[] = [
  {
    id: 'edit-01-config-value',
    category: 'software-engineering',
    probe: '基线题:定位并修改单个配置值。无循环也应该做得出来。',
    prompt: '把 config.json 里的超时时间改成 30000 毫秒,其它字段保持不变。',
    setup: {
      'config.json': JSON.stringify({ name: 'svc', timeoutMs: 5000, retries: 3, endpoint: 'https://api.example.com' }, null, 2),
    },
    async check(ws) {
      const notes: string[] = [];
      let j: any;
      try { j = JSON.parse(await ws.read('config.json')); } catch { return { completion: 0, notes: ['config.json 不是合法 JSON'] }; }
      let score = 0;
      if (j.timeoutMs === 30000) { score += 0.6; notes.push('timeoutMs=30000 ✓'); } else notes.push(`timeoutMs=${j.timeoutMs} ✗`);
      const intact = j.name === 'svc' && j.retries === 3 && j.endpoint === 'https://api.example.com';
      if (intact) { score += 0.4; notes.push('其它字段完好 ✓'); } else notes.push('其它字段被改动 ✗');
      return { completion: score, notes };
    },
  },

  {
    id: 'edit-02-unique-occurrence',
    category: 'software-engineering',
    probe: '同一文本出现多次时只改指定那处。考 edit_file 的唯一性纪律与"先读后改"。',
    prompt: '在 server.ts 里,只把 **startServer 函数内部**的 port 默认值从 3000 改成 8080。文件里其它地方的 3000 一律不要动。',
    setup: {
      'server.ts': [
        '// 历史默认值:3000',
        'export const LEGACY_PORT = 3000;',
        '',
        'export function startServer(port = 3000) {',
        '  console.log("listening on " + port);',
        '  return port;',
        '}',
        '',
        'export function startMetrics(port = 3000) {',
        '  return port;',
        '}',
      ].join('\n'),
    },
    async check(ws) {
      const src = await ws.read('server.ts');
      const notes: string[] = [];
      let score = 0;
      if (/export function startServer\(port = 8080\)/.test(src)) { score += 0.6; notes.push('startServer 默认值=8080 ✓'); }
      else notes.push('startServer 默认值未正确修改 ✗');
      if (/export const LEGACY_PORT = 3000;/.test(src)) { score += 0.2; notes.push('LEGACY_PORT 未被误改 ✓'); } else notes.push('LEGACY_PORT 被误改 ✗');
      if (/export function startMetrics\(port = 3000\)/.test(src)) { score += 0.2; notes.push('startMetrics 未被误改 ✓'); } else notes.push('startMetrics 被误改 ✗');
      return { completion: score, notes };
    },
  },

  {
    id: 'refactor-01-rename-across-files',
    category: 'multi-file-refactor',
    probe: '跨 4 个文件重命名一个导出常量。漏改任何一处都算没做完——这是最典型的"必须先检索"场景。',
    prompt: '把常量 MAX_RETRY 重命名为 RETRY_LIMIT。所有定义处和引用处都要改,不能留下任何 MAX_RETRY。',
    setup: {
      'src/constants.js': 'export const MAX_RETRY = 3;\nexport const TIMEOUT = 1000;\n',
      'src/client.js': 'import { MAX_RETRY } from "./constants.js";\n\nexport function request() {\n  for (let i = 0; i < MAX_RETRY; i++) {}\n}\n',
      'src/worker.js': 'import { MAX_RETRY, TIMEOUT } from "./constants.js";\n\nexport const cfg = { retries: MAX_RETRY, timeout: TIMEOUT };\n',
      'docs/notes.md': '重试次数由 MAX_RETRY 控制,默认 3 次。\n',
    },
    async check(ws) {
      const files = ['src/constants.js', 'src/client.js', 'src/worker.js', 'docs/notes.md'];
      const notes: string[] = [];
      let renamed = 0, leftover = 0;
      for (const f of files) {
        const src = await ws.exists(f) ? await ws.read(f) : '';
        if (/MAX_RETRY/.test(src)) { leftover++; notes.push(`${f} 仍残留 MAX_RETRY ✗`); }
        if (/RETRY_LIMIT/.test(src)) renamed++;
      }
      notes.push(`${renamed}/4 个文件已含 RETRY_LIMIT,${leftover} 个文件仍有残留`);
      // 全改完才是"做完了";部分完成按比例给,但残留一处就明显扣
      const completion = leftover === 0 && renamed === 4 ? 1 : Math.max(0, (renamed - leftover) / 4);
      return { completion, notes };
    },
  },

  {
    id: 'bug-01-off-by-one',
    category: 'software-engineering',
    probe: '有现成测试的 bug 修复。oracle = 跑测试,过了才算过。',
    prompt: '运行 test.js,它会失败。找出 sum.js 里的 bug 并修复,让测试全部通过。不要改 test.js。',
    setup: {
      'sum.js': [
        '// 返回数组 [from, to] 闭区间内所有整数之和',
        'export function rangeSum(from, to) {',
        '  let s = 0;',
        '  for (let i = from; i < to; i++) s += i;',
        '  return s;',
        '}',
      ].join('\n'),
      'test.js': [
        'import { rangeSum } from "./sum.js";',
        'import assert from "node:assert/strict";',
        'assert.equal(rangeSum(1, 5), 15, "1..5 应为 15");',
        'assert.equal(rangeSum(3, 3), 3, "3..3 应为 3");',
        'assert.equal(rangeSum(-2, 2), 0, "-2..2 应为 0");',
        'console.log("ALL TESTS PASSED");',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'bugfix', type: 'module' }, null, 2),
    },
    async check(ws) {
      const notes: string[] = [];
      const testSrc = await ws.read('test.js');
      if (!/ALL TESTS PASSED/.test(testSrc) || !/rangeSum\(1, 5\), 15/.test(testSrc)) {
        return { completion: 0, notes: ['test.js 被改动 —— 判定作弊,0 分'] };
      }
      const r = await runNode(ws, 'test.js');
      if (r.code === 0 && /ALL TESTS PASSED/.test(r.out)) { notes.push('测试全部通过 ✓'); return { completion: 1, notes }; }
      notes.push(`测试未通过(exit=${r.code}): ${r.out.split('\n').find(Boolean) ?? ''}`);
      // 改对了方向(用了 <=)但没跑通,给一点部分分
      const src = await ws.read('sum.js');
      return { completion: /i <= to/.test(src) ? 0.4 : 0, notes };
    },
  },

  {
    id: 'bug-02-implement-stub',
    category: 'software-engineering',
    probe: '从空实现写到测试全绿。需要读测试反推契约。',
    prompt: '实现 slugify.js 里的 slugify 函数,让 test.js 全部通过。不要改 test.js。',
    setup: {
      'slugify.js': 'export function slugify(input) {\n  // TODO: 实现我\n  return "";\n}\n',
      'test.js': [
        'import { slugify } from "./slugify.js";',
        'import assert from "node:assert/strict";',
        'assert.equal(slugify("Hello World"), "hello-world");',
        'assert.equal(slugify("  Trim  Me  "), "trim-me");',
        'assert.equal(slugify("Special!@# Chars"), "special-chars");',
        'assert.equal(slugify("multiple---dashes"), "multiple-dashes");',
        'assert.equal(slugify(""), "");',
        'console.log("ALL TESTS PASSED");',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'slug', type: 'module' }, null, 2),
    },
    async check(ws) {
      const testSrc = await ws.read('test.js');
      if (!/ALL TESTS PASSED/.test(testSrc) || !/slugify\("Special!@# Chars"\), "special-chars"/.test(testSrc)) {
        return { completion: 0, notes: ['test.js 被改动 —— 判定作弊,0 分'] };
      }
      const r = await runNode(ws, 'test.js');
      if (r.code === 0 && /ALL TESTS PASSED/.test(r.out)) return { completion: 1, notes: ['测试全部通过 ✓'] };
      const src = await ws.read('slugify.js');
      const attempted = !/TODO: 实现我/.test(src) && src.length > 80;
      return { completion: attempted ? 0.3 : 0, notes: [`测试未通过: ${r.out.split('\n').find(Boolean) ?? ''}`, attempted ? '有实现尝试' : '未动手'] };
    },
  },
];
