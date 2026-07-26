/** 硬题:专门戳"一次性给全信息 + 一次性输出"的天花板。
 *
 * 前面那批题里 raw 拿了 80+%,因为工作区能整个塞进提示词,题目本质是"改写一段文本"。
 * 这批题不同 —— 答案**不在初始状态里**,必须靠执行、迭代或大范围检索产生:
 *   - execute-to-know:答案是程序跑出来的,不跑就得心算五千次迭代
 *   - iterative-debug:测试 fail-fast,一次只暴露一个错,不迭代就修不全
 *   - large-workspace:30 个文件塞进提示词要几万 token,检索才是正解
 * 这才是 agent harness 真正的价值区间。 */
import type { BenchTask } from '../types.js';
import { runNode } from './coding.js';

/* ---------- 固件 ---------- */

const GEN_JS = [
  '// 确定性伪随机累加器。不跑一遍是算不出来的。',
  'let x = 7;',
  'let acc = 0;',
  'for (let i = 0; i < 5000; i++) {',
  '  x = (x * 1103515245 + 12345) % 2147483648;',
  '  acc = (acc + (x % 97)) % 1000003;',
  '}',
  'console.log(acc);',
].join('\n');

/** 用例与期望值由同一个参考实现算出,不手抄数字 */
const DURATION_CASES: [string, number][] = (() => {
  const UNITS: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
  const truth = (s: string) => [...s.matchAll(/(\d+)([dhms])/g)].reduce((a, m) => a + Number(m[1]) * UNITS[m[2]], 0);
  const inputs = [
    '30s', '1m', '90s', '2m30s', '1h', '1h30m', '2h15m30s', '1d', '1d2h', '3d4h5m6s',
    '0s', '10m', '45s', '5h', '1d1s', '12h30m', '7d', '2d12h', '100s', '1m1s',
  ];
  return inputs.map(i => [i, truth(i)] as [string, number]);
})();

const LARGE_WS = (() => {
  const files: Record<string, string> = {};
  const deprecated: string[] = [];
  // 30 个模块,每个 ~40 行;其中 7 个含 @deprecated 导出
  const marks = new Set([3, 8, 11, 17, 22, 26, 29]);
  for (let i = 0; i < 30; i++) {
    const name = `mod${String(i).padStart(2, '0')}`;
    const lines = [`/** 模块 ${name} */`, ''];
    for (let j = 0; j < 12; j++) {
      const fn = `${name}_fn${j}`;
      if (marks.has(i) && j === i % 12) {
        lines.push('/** @deprecated 请改用新接口 */', `export function ${fn}() { return ${i * 100 + j}; }`, '');
        deprecated.push(fn);
      } else {
        lines.push(`export function ${fn}() { return ${i * 100 + j}; }`, '');
      }
    }
    files[`packages/${name}/index.js`] = lines.join('\n');
  }
  return { files, deprecated: deprecated.sort() };
})();

/** 三个互不相干的子系统,每个都要独立数一遍调用次数。
 *  这类"多个自成一体的子任务"正是委派的适用形状:子 agent 各查各的,父 agent 只收三个数字。 */
const SUBSYSTEMS = (() => {
  const files: Record<string, string> = {};
  const answer: Record<string, string> = {};
  const plan: Record<string, [string, number][]> = {
    // service → [函数名, 被调用次数]
    auth: [['verifyToken', 5], ['hashPassword', 2], ['issueJwt', 3]],
    billing: [['chargeCard', 2], ['refund', 6], ['invoice', 1]],
    search: [['indexDoc', 4], ['queryIndex', 7], ['rerank', 3]],
  };
  for (const [svc, fns] of Object.entries(plan)) {
    files[`services/${svc}/api.js`] = fns.map(([f]) => `export function ${f}(x) { return x; }`).join('\n') + '\n';
    // 把调用摊到 5 个文件里,逼着逐个读/检索
    const calls: string[] = [];
    for (const [fn, n] of fns) for (let i = 0; i < n; i++) calls.push(fn);
    for (let i = 0; i < 5; i++) {
      const mine = calls.filter((_, j) => j % 5 === i);
      files[`services/${svc}/mod${i}.js`] =
        `import { ${fns.map(([f]) => f).join(', ')} } from "./api.js";\n\n`
        + mine.map((f, k) => `export const r${k} = ${f}(${k});`).join('\n') + '\n';
    }
    answer[svc] = fns.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  }
  return { files, answer };
})();

/* ---------- 任务 ---------- */

export const hardTasks: BenchTask[] = [
  {
    id: 'hard-01-execute-to-know',
    category: 'long-horizon',
    probe: '答案是 5000 次迭代跑出来的数。有执行能力就是一条命令,没有就只能心算。',
    prompt: '运行 gen.js,把它打印出来的那个数字(且只有那个数字)写入 result.txt。不要修改 gen.js。',
    setup: { 'gen.js': GEN_JS, 'package.json': JSON.stringify({ name: 'gen', type: 'module' }, null, 2) },
    async check(ws) {
      if (await ws.read('gen.js') !== GEN_JS) return { completion: 0, notes: ['gen.js 被改动 —— 判定作弊,0 分'] };
      if (!await ws.exists('result.txt')) return { completion: 0, notes: ['result.txt 不存在'] };
      const truth = (await runNode(ws, 'gen.js')).out.trim();     // 标准答案当场跑出来,不会和题目对不上
      const got = (await ws.read('result.txt')).trim();
      const ok = got === truth || (got.match(/-?\d+/)?.[0] === truth);
      return { completion: ok ? 1 : 0, notes: [ok ? `答案 ${truth} ✓` : `期望 ${truth},得到 "${got.slice(0, 60)}" ✗`] };
    },
  },

  {
    id: 'hard-02-iterative-debug',
    category: 'software-engineering',
    probe: '三个独立 bug + fail-fast 测试:一次只暴露一个错。不迭代就修不全。',
    prompt: '运行 test.js,它会失败。修复 duration.js 里的所有 bug,直到测试全部通过。不要修改 test.js 和 cases.json。',
    setup: {
      // 注意:这里不能留任何"bug 在这行"的提示注释,否则等于把答案写在题面上
      'duration.js': [
        '// 把 "1d2h30m15s" 这类时长字符串解析成总秒数',
        'const UNITS = { d: 86400, h: 3600, m: 60, s: 1 };',
        'const ALIAS = { d: "h", h: "h", m: "m", s: "s" };',
        '',
        'export function parseDuration(input) {',
        '  let total = 0;',
        '  const m = /(\\d+)([dhms])/.exec(input);',
        '  if (!m) return 0;',
        '  const unit = ALIAS[m[2]];',
        '  total += Number(m[1]) * UNITS[unit];',
        '  return total;',
        '}',
      ].join('\n'),
      'cases.json': JSON.stringify(DURATION_CASES),
      'test.js': [
        'import { parseDuration } from "./duration.js";',
        'import { readFileSync } from "node:fs";',
        'const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));',
        'for (const [input, expected] of cases) {',
        '  const got = parseDuration(input);',
        '  if (got !== expected) {',
        '    console.error(`FAIL: parseDuration("${input}") => ${got}, 期望 ${expected}`);',
        '    process.exit(1);',
        '  }',
        '}',
        'console.log("ALL TESTS PASSED");',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'dur', type: 'module' }, null, 2),
    },
    async check(ws) {
      const testSrc = await ws.read('test.js');
      const casesSrc = await ws.read('cases.json');
      if (!/ALL TESTS PASSED/.test(testSrc) || !/process\.exit\(1\)/.test(testSrc)) {
        return { completion: 0, notes: ['test.js 被改动 —— 判定作弊,0 分'] };
      }
      if (casesSrc !== JSON.stringify(DURATION_CASES)) return { completion: 0, notes: ['cases.json 被改动 —— 判定作弊,0 分'] };

      const r = await runNode(ws, 'test.js');
      if (r.code === 0 && /ALL TESTS PASSED/.test(r.out)) return { completion: 1, notes: ['全部 20 条用例通过 ✓'] };

      // 部分分:数出实际通过了几条,反映"修到什么程度"
      let passed = 0;
      try {
        const mod = await import(`file://${ws.root.replace(/\\/g, '/')}/duration.js?t=${Date.now()}`);
        for (const [input, expected] of DURATION_CASES) if (mod.parseDuration(input) === expected) passed++;
      } catch { /* 语法错就是 0 条 */ }
      return {
        completion: Math.min(0.9, passed / DURATION_CASES.length),
        notes: [`${passed}/${DURATION_CASES.length} 条用例通过`, r.out.split('\n').find(l => /FAIL/.test(l)) ?? ''],
      };
    },
  },

  {
    id: 'hard-03-large-workspace',
    category: 'retrieval',
    probe: '30 个模块 × 12 个导出。全文塞进提示词要几万 token,grep 一次就完事 —— 考的是"会不会检索"。',
    prompt: `packages/ 下有很多模块。找出所有被标记为 @deprecated 的导出函数名,写入 deprecated.txt,每行一个,按字母序排列。不要写其它内容。`,
    setup: LARGE_WS.files,
    async check(ws) {
      if (!await ws.exists('deprecated.txt')) return { completion: 0, notes: ['deprecated.txt 不存在'] };
      const got = (await ws.read('deprecated.txt')).split('\n').map(s => s.trim()).filter(Boolean);
      const want = LARGE_WS.deprecated;
      if (JSON.stringify(got) === JSON.stringify(want)) return { completion: 1, notes: [`${want.length} 个全对且有序 ✓`] };

      const hit = want.filter(w => got.includes(w)).length;
      const extra = got.filter(g => !want.includes(g)).length;
      // 召回率减去误报惩罚:漏了扣分,乱报也扣分
      const completion = Math.max(0, (hit - extra * 0.5) / want.length) * (JSON.stringify(got) === JSON.stringify([...got].sort()) ? 1 : 0.8);
      return {
        completion: Math.min(0.95, completion),
        notes: [`命中 ${hit}/${want.length},误报 ${extra}`, `期望 ${want.join(',')}`, `实际 ${got.join(',').slice(0, 200)}`],
      };
    },
  },

  {
    id: 'hard-04-three-subsystems',
    category: 'long-horizon',
    probe: '三个互不相干的子系统各查一遍。典型的可委派形状 —— 子任务自成一体,过程不必进主上下文。',
    prompt: `services/ 下有 auth、billing、search 三个子系统。
分别找出每个子系统内部**被调用**次数最多的那个函数(不含 api.js 里的定义行),写入 report.txt,格式三行:
auth=<函数名>
billing=<函数名>
search=<函数名>`,
    setup: SUBSYSTEMS.files,
    async check(ws) {
      if (!await ws.exists('report.txt')) return { completion: 0, notes: ['report.txt 不存在'] };
      const txt = await ws.read('report.txt');
      const notes: string[] = [];
      let hit = 0;
      for (const [svc, fn] of Object.entries(SUBSYSTEMS.answer)) {
        const line = txt.split('\n').find(l => new RegExp(`^\\s*${svc}\\b`, 'i').test(l)) ?? '';
        if (new RegExp(`\\b${fn}\\b`).test(line)) { hit++; notes.push(`${svc}=${fn} ✓`); }
        else notes.push(`${svc} 错误(期望 ${fn},得到 "${line.trim()}") ✗`);
      }
      return { completion: hit / 3, notes };
    },
  },
];
