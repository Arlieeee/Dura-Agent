/** 数据/检索类:必须真的读进数据算,靠猜答不出来(数字刻意选成不好蒙的)。
 * 数据与标准答案由同一段代码生成 —— 任务和 oracle 共用一份真相,不会对不上。 */
import type { BenchTask } from '../types.js';

/** 宽松读答案:允许模型多写单位/标点,只要数值对得上。 */
const num = (s: string): number[] => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

/* ---------- 固件生成(必须先于 tasks 求值) ---------- */

const SALES = (() => {
  const regions = ['north', 'south', 'east', 'west'];
  const rows = ['id,region,revenue'];
  let total = 0, top = -1, topRegion = '';
  for (let i = 1; i <= 40; i++) {
    const region = regions[i % 4];
    const revenue = (137 * i) % 911 + 100;          // 无规律但确定
    rows.push(`${i},${region},${revenue}`);
    total += revenue;
    if (revenue > top) { top = revenue; topRegion = region; }
  }
  return { csv: rows.join('\n') + '\n', total, topRegion };
})();

const RETRIEVAL = (() => {
  const files: Record<string, string> = {
    'src/api.js': 'export function fetchUser(id) { return { id }; }\nexport function fetchOrder(id) { return { id }; }\n',
  };
  const plan: [string, number][] = [['a', 2], ['b', 0], ['c', 3], ['d', 1], ['e', 0], ['f', 2], ['g', 1]];
  let calls = 0;
  for (const [name, n] of plan) {
    const lines = ['import { fetchUser, fetchOrder } from "./api.js";', ''];
    for (let i = 0; i < n; i++) lines.push(`export const u${i} = fetchUser(${i});`);
    lines.push('export const o = fetchOrder(1);');
    files[`src/${name}.js`] = lines.join('\n') + '\n';
    calls += n;
  }
  return { files, calls };
})();

const LOGS = (() => {
  const pattern: Record<string, string[]> = {
    'logs/app.log': ['INFO', 'INFO', 'ERROR', 'WARN', 'INFO', 'ERROR'],
    'logs/worker.log': ['WARN', 'WARN', 'INFO', 'ERROR', 'INFO'],
    'logs/db.log': ['ERROR', 'ERROR', 'INFO', 'WARN'],
  };
  const files: Record<string, string> = {};
  const counts: Record<string, number> = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const [path, levels] of Object.entries(pattern)) {
    files[path] = levels.map((lv, i) => `2026-07-2${i % 9} 10:0${i}:00 ${lv} message ${i}`).join('\n') + '\n';
    for (const lv of levels) counts[lv]++;
  }
  return { files, counts };
})();

/* ---------- 任务 ---------- */

export const dataTasks: BenchTask[] = [
  {
    id: 'data-01-csv-aggregate',
    category: 'data-analysis',
    probe: '读 CSV 做聚合。40 行数据超出"扫一眼心算"的范围。',
    prompt: '读取 sales.csv,算出:(1) revenue 列的总和;(2) revenue 最高的那一行的 region 值。把结果写进 answer.txt,格式两行:\ntotal=<总和>\ntop_region=<region>',
    setup: { 'sales.csv': SALES.csv },
    async check(ws) {
      const notes: string[] = [];
      if (!await ws.exists('answer.txt')) return { completion: 0, notes: ['answer.txt 不存在'] };
      const txt = await ws.read('answer.txt');
      let score = 0;
      const totalLine = txt.split('\n').find(l => /total/i.test(l)) ?? '';
      if (num(totalLine).includes(SALES.total)) { score += 0.6; notes.push(`total=${SALES.total} ✓`); }
      else notes.push(`total 错误(期望 ${SALES.total},得到 "${totalLine.trim()}") ✗`);
      if (new RegExp(`top_region\\s*=\\s*${SALES.topRegion}\\b`, 'i').test(txt)) { score += 0.4; notes.push(`top_region=${SALES.topRegion} ✓`); }
      else notes.push(`top_region 错误(期望 ${SALES.topRegion}) ✗`);
      return { completion: score, notes };
    },
  },

  {
    id: 'data-02-json-transform',
    category: 'data-analysis',
    probe: '带过滤+排序+字段投影的结构化转换。输出格式严格,考"照规格干活"。',
    prompt: `读取 users.json,筛选出 active 为 true 且 age >= 30 的用户,按 age 从大到小排序,输出为 result.json。
每条只保留 name 和 age 两个字段,结果是一个数组。`,
    setup: {
      'users.json': JSON.stringify([
        { name: 'ada', age: 36, active: true }, { name: 'bob', age: 29, active: true },
        { name: 'cy', age: 41, active: false }, { name: 'dee', age: 30, active: true },
        { name: 'eve', age: 55, active: true }, { name: 'fay', age: 22, active: false },
        { name: 'gus', age: 33, active: true }, { name: 'hal', age: 30, active: false },
      ], null, 2),
    },
    async check(ws) {
      if (!await ws.exists('result.json')) return { completion: 0, notes: ['result.json 不存在'] };
      let got: any;
      try { got = JSON.parse(await ws.read('result.json')); } catch { return { completion: 0, notes: ['result.json 不是合法 JSON'] }; }
      const want = [{ name: 'eve', age: 55 }, { name: 'ada', age: 36 }, { name: 'gus', age: 33 }, { name: 'dee', age: 30 }];
      if (!Array.isArray(got)) return { completion: 0, notes: ['结果不是数组'] };
      if (JSON.stringify(got) === JSON.stringify(want)) return { completion: 1, notes: ['完全匹配(筛选/排序/字段裁剪都对)✓'] };

      const notes = [`期望 ${JSON.stringify(want)}`, `实际 ${JSON.stringify(got).slice(0, 300)}`];
      const gotNames = got.map((x: any) => x?.name);
      if (JSON.stringify(gotNames) === JSON.stringify(want.map(x => x.name))) {
        notes.push('筛选与排序正确,字段裁剪有出入');
        return { completion: 0.7, notes };
      }
      if (gotNames.length === 4 && want.every(w => gotNames.includes(w.name))) {
        notes.push('筛选正确,排序错误');
        return { completion: 0.5, notes };
      }
      return { completion: 0, notes };
    },
  },

  {
    id: 'retrieval-01-count-across-files',
    category: 'retrieval',
    probe: '跨 8 个文件统计调用次数。不 grep 就得逐个读完,预算内几乎做不到。',
    prompt: '在 src/ 目录下的所有 .js 文件里,统计函数 fetchUser 一共被**调用**了多少次(不含它的定义行)。把数字写进 answer.txt,内容只要一个数字。',
    setup: RETRIEVAL.files,
    async check(ws) {
      if (!await ws.exists('answer.txt')) return { completion: 0, notes: ['answer.txt 不存在'] };
      const got = num(await ws.read('answer.txt'));
      const ok = got.includes(RETRIEVAL.calls);
      return { completion: ok ? 1 : 0, notes: [ok ? `答案 ${RETRIEVAL.calls} ✓` : `期望 ${RETRIEVAL.calls},得到 ${JSON.stringify(got)} ✗`] };
    },
  },

  {
    id: 'retrieval-02-log-summary',
    category: 'retrieval',
    probe: '多文件日志按级别聚合并按规定格式落盘。考"检索 + 归类 + 严格输出"。',
    prompt: `读取 logs/ 下所有 .log 文件,统计 ERROR、WARN、INFO 三个级别各出现多少行,写进 summary.txt,格式三行:
ERROR=<n>
WARN=<n>
INFO=<n>`,
    setup: LOGS.files,
    async check(ws) {
      if (!await ws.exists('summary.txt')) return { completion: 0, notes: ['summary.txt 不存在'] };
      const txt = await ws.read('summary.txt');
      const notes: string[] = [];
      let hit = 0;
      for (const [level, want] of Object.entries(LOGS.counts)) {
        const line = txt.split('\n').find(l => new RegExp(`^\\s*${level}\\b`, 'i').test(l)) ?? '';
        if (num(line).includes(want)) { hit++; notes.push(`${level}=${want} ✓`); }
        else notes.push(`${level} 错误(期望 ${want},得到 "${line.trim()}") ✗`);
      }
      return { completion: hit / 3, notes };
    },
  },
];
