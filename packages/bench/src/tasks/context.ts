/** 上下文压力题:关键信息落在工具输出的 4000 字符之后。
 *
 * 前 18 题的文件都不超过 3000 字符,工具结果几乎碰不到内联上限 —— 那条上限曾经是**悄悄截断**:
 * 模型看不到后半截,也不知道被截了。这三题专门把答案放在尾部:测试汇总、最后一条报错、大文件后段的配置项。 */
import type { BenchTask } from '../types.js';
import { runNode } from './coding.js';

/* ---------- ctx-01:失败用例在 400 行输出的末尾 ---------- */
const PRICE_BUGGY = [
  'export const add = (a, b) => a + b;',
  'export const discount = (price, pct) => Math.round(price * (100 - pct)) / 100;',
  '// 增值税:按分四舍五入',
  'export const vatAmount = (net, rate) => Math.floor(net * rate * 100) / 100;',
  'export const total = (net, rate) => Math.round((net + vatAmount(net, rate)) * 100) / 100;',
].join('\n') + '\n';
const PRICE_FIXED = PRICE_BUGGY.replace('Math.floor(net * rate * 100)', 'Math.round(net * rate * 100)');
const CHECKS = [
  'import { add, discount, vatAmount, total } from "./price.js";',
  'let passed = 0, failed = 0;',
  'const check = (name, got, want) => {',
  '  if (got === want) { passed++; console.log(`PASS ${name}`); }',
  '  else { failed++; console.log(`FAIL ${name}: expected ${want}, got ${got}`); }',
  '};',
  'for (let i = 0; i < 400; i++) check(`add_${i}`, add(i, 1), i + 1);',
  'check("discount_basic", discount(200, 15), 170);',
  'check("vat_rounding", vatAmount(10.99, 0.2), 2.2);',
  'check("total_basic", total(100, 0.2), 120);',
  'console.log(`${passed} passed, ${failed} failed`);',
  'if (failed) process.exitCode = 1; else console.log("ALL CHECKS PASSED");',
].join('\n') + '\n';

/* ---------- ctx-02:最后一条 ERROR 在 1500 行日志的末段 ---------- */
const LOG = (() => {
  const lines: string[] = [];
  let lastError = '';
  for (let i = 0; i < 1500; i++) {
    const ts = `2026-09-30T${String(10 + Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
    const req = `r${String(1000 + (i * 7919) % 9000)}`;
    if (i % 25 === 17) { lines.push(`${ts} ERROR req=${req} path=/api/pay status=500 msg=upstream timeout`); lastError = req; }
    else lines.push(`${ts} INFO  req=${req} path=/api/items status=200`);
  }
  return { text: lines.join('\n') + '\n', lastError };
})();

/* ---------- ctx-03:要改的配置项在 700 行文件的后段,前面有个名字相近的诱饵 ---------- */
const INI = (() => {
  const lines: string[] = ['[network]', 'max_connections_per_host = 10'];
  for (let s = 0; s < 6; s++) {
    lines.push('', `[service_${s}]`);
    for (let k = 0; k < 110; k++) lines.push(`option_${s}_${k} = value_${s}_${k}`);
  }
  lines.push('', '[database]', 'host = db.internal', 'port = 5432', 'max_connections = 100', 'pool_timeout = 30');
  return lines.join('\n') + '\n';
})();

export const contextTasks: BenchTask[] = [
  {
    id: 'ctx-01-test-tail',
    category: 'context-pressure',
    probe: '测试输出 400+ 行,唯一的失败和汇总在末尾。只看得见开头就不知道哪条挂了。',
    prompt: '运行 `node checks.js`,修好导致失败的那个 bug(只许改 price.js,不要改 checks.js),直到全部通过。',
    setup: { 'package.json': '{ "type": "module" }\n', 'price.js': PRICE_BUGGY, 'checks.js': CHECKS },
    async check(ws) {
      if ((await ws.read('checks.js')) !== CHECKS) return { completion: 0, notes: ['checks.js 被改动(作弊)'] };
      // 看退出码不看输出:runNode 只留前 2000 字符,"全部通过"的汇总恰好在尾部 —— 判分器自己也会掉进这个坑
      const r = await runNode(ws, 'checks.js');
      return r.code === 0 ? { completion: 1, notes: ['全部通过 ✓'] } : { completion: 0, notes: ['checks.js 仍以非零退出'] };
    },
  },
  {
    id: 'ctx-02-last-error',
    category: 'context-pressure',
    probe: '1500 行日志、60 条 ERROR,问最后一条。grep 结果若被截断,模型会把"看得见的最后一条"当答案。',
    prompt: 'logs/server.log 里**最后一条** ERROR 的 req 编号是什么?只把编号(形如 r1234)写入 answer.txt,不要写别的。',
    setup: { 'logs/server.log': LOG.text },
    async check(ws) {
      if (!await ws.exists('answer.txt')) return { completion: 0, notes: ['answer.txt 不存在'] };
      const got = (await ws.read('answer.txt')).trim();
      return got === LOG.lastError
        ? { completion: 1, notes: ['最后一条 ERROR 找对了 ✓'] }
        : { completion: 0, notes: [`期望 ${LOG.lastError},实际 ${got.slice(0, 40)}`] };
    },
  },
  {
    id: 'ctx-03-big-config',
    category: 'context-pressure',
    probe: '700 行配置文件,目标项在后段;开头有个名字相近的诱饵。只看见前半截容易改错地方。',
    prompt: '把 config/app.ini 里 [database] 段的 max_connections 改成 500。只改这一处,其它行保持原样。',
    setup: { 'config/app.ini': INI },
    async check(ws) {
      const got = (await ws.read('config/app.ini')).replace(/\r/g, '');
      if (got === INI.replace('max_connections = 100', 'max_connections = 500')) return { completion: 1, notes: ['只改了目标行 ✓'] };
      const notes = [];
      if (!/^max_connections = 500$/m.test(got)) notes.push('[database] 的 max_connections 没改成 500');
      if (!got.includes('max_connections_per_host = 10')) notes.push('诱饵 max_connections_per_host 被改了');
      if (got.split('\n').length !== INI.split('\n').length) notes.push('行数变了');
      return { completion: notes.length ? 0 : 0.5, notes: notes.length ? notes : ['目标行对了,但别处也有改动'] };
    },
  },
];

/** oracle 自测用:标准解从固件现推 */
export const contextGolden: Record<string, Record<string, string>> = {
  'ctx-01-test-tail': { 'price.js': PRICE_FIXED },
  'ctx-02-last-error': { 'answer.txt': LOG.lastError + '\n' },
  'ctx-03-big-config': { 'config/app.ini': INI.replace('max_connections = 100', 'max_connections = 500') },
};
