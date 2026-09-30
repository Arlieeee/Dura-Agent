/** 报告生成:结果 → markdown。给人看的表格,不是给机器读的 JSON dump。 */
import type { RunRecord } from './types.js';
import { aggregate } from './score.js';
import type { Harness } from './types.js';

const pct = (x: number) => (x * 100).toFixed(1) + '%';
const n2 = (x: number) => x.toFixed(2);

/** 官方定价($/M token,api-docs.deepseek.com/quick_start/pricing,2026-09-30 取)。认不出的模型不猜价,成本列留空。
 *  按闲时价记:高峰时段三项同乘 2,不改变各档之间的比值,跑分在什么时段跑都可比。 */
const FLASH = { input: 0.15, output: 0.6, cacheRead: 0.003 };
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'deepseek-flash': FLASH,
  'deepseek-v4-flash': FLASH,          // 旧名仍可用,已由 V4.1-Flash 承接、按 Flash 计费
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022 },
};
/** 命中缓存的 prompt 按缓存读价算,其余按输入价。命中价便宜 50 倍以上,不拆开算成本就只是上界。 */
function costOf(model: string, promptTokens: number, completionTokens: number, cachedTokens = 0): string {
  const p = PRICING[model];
  if (!p) return '—';
  const usd = ((promptTokens - cachedTokens) * p.input + cachedTokens * p.cacheRead + completionTokens * p.output) / 1_000_000;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;
}

export function renderReport(records: RunRecord[], harnesses: Harness[], meta: { model: string[]; budget: { maxSteps: number; timeoutMs: number }; startedAt: string; wallMs: number }): string {
  const aggs = aggregate(records);
  const taskIds = [...new Set(records.map(r => r.taskId))].sort();
  const hIds = harnesses.map(h => h.id);
  const L: string[] = [];

  L.push('# my-agent Bench — harness 对照评测报告', '');
  L.push(`> 生成于 ${meta.startedAt} · 耗时 ${(meta.wallMs / 1000).toFixed(0)}s · 模型 \`${meta.model.join(', ')}\` · 预算 maxSteps=${meta.budget.maxSteps} timeout=${meta.budget.timeoutMs / 1000}s`, '');
  L.push('方法论沿用 Harness-Bench(arXiv:2605.27922):**固定**任务提示、初始沙箱、预算、超时、评分器,**只变** harness。');
  L.push('三档 harness 共用同一个 provider 实现、同一套工具实现、同一个端点——分差因此可以归因到编排层。', '');

  L.push('## 被测配置', '');
  L.push('| harness | 说明 |', '|---|---|');
  for (const h of harnesses) L.push(`| \`${h.id}\` | ${h.describe} |`);
  L.push('');

  L.push('## 总分', '');
  L.push('| harness | 模型 | Completion | TaskScore | Process | 越权 | LLM 调用/题 | 工具调用/题 | 工具报错/题 | 总 token | 缓存命中 | 成本 | 成本/题 | 平均耗时 |');
  L.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const a of aggs) {
    const total = a.totalPromptTokens + a.totalCompletionTokens;
    L.push(`| \`${a.harnessId}\` | ${a.model} | **${pct(a.completion)}** | ${pct(a.taskScore)} | ${pct(a.process)} | ${a.securityFailures} | ${n2(a.avgLlmCalls)} | ${n2(a.avgToolCalls)} | ${n2(a.avgToolErrors)} | ${total.toLocaleString()} | ${a.totalCachedTokens ? pct(a.totalCachedTokens / a.totalPromptTokens) : '—'} | ${costOf(a.model, a.totalPromptTokens, a.totalCompletionTokens, a.totalCachedTokens)} | ${costOf(a.model, a.totalPromptTokens / a.n, a.totalCompletionTokens / a.n, a.totalCachedTokens / a.n)} | ${(a.avgWallMs / 1000).toFixed(1)}s |`);
  }
  L.push('');
  L.push('- **Completion** = oracle 判定的客观完成度(主指标,答"做成了吗")');
  L.push('- **TaskScore** = Security × Completion × Process(答"做得体面吗";越权直接 0)');
  L.push('- **Process** = 错误恢复 / 预算效率 / 终态自洽 的均值,带 0.4 地板');
  L.push('- **缓存命中** = prompt token 里命中服务端前缀缓存的比例;成本按命中价 / 未命中价分开算');
  L.push('');

  L.push('> 「平均耗时」仅供参考:跑分是并发的,单格 wallMs 会被 API 排队放大(实测同一格串行 10s / 并发下偶发 130s)。');
  L.push('> 比较效率请看 LLM 调用数与 token,它们不受并发影响。', '');

  /* --- 相对基线的增量:这份报告真正要回答的问题 --- */
  L.push('## harness 带来的增量(相对原生 API)', '');
  L.push('| 模型 | harness | Completion | 相对 raw | 相对提升 |', '|---|---|---:|---:|---:|');
  for (const mdl of [...new Set(aggs.map(a => a.model))]) {
    const group = aggs.filter(a => a.model === mdl);
    const raw = group.find(a => a.harnessId === 'raw');
    if (!raw) continue;
    for (const a of [...group].sort((x, y) => y.completion - x.completion)) {
      const delta = a.completion - raw.completion;
      const rel = raw.completion > 0 ? `${((delta / raw.completion) * 100).toFixed(0)}%` : (delta > 0 ? '∞' : '—');
      L.push(`| ${mdl} | \`${a.harnessId}\` | ${pct(a.completion)} | ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pt | ${a.harnessId === 'raw' ? '—' : rel} |`);
    }
  }
  L.push('');

  // 多模型时按模型分节:不分开的话两个模型的分会被混进同一格,表就没意义了
  const modelIds = [...new Set(records.map(r => r.model))];
  const reps = Math.max(1, ...records.map(r => (r.rep ?? 0) + 1));
  const cats = [...new Set(records.map(r => r.category))].sort();

  for (const mdl of modelIds) {
    const mine = records.filter(r => r.model === mdl);
    const present = hIds.filter(h => mine.some(r => r.harnessId === h));
    const head = modelIds.length > 1 ? ` — \`${mdl}\`` : '';

    L.push(`## 分类得分(Completion)${head}`, '');
    L.push(`| 能力维度 | ${present.map(h => `\`${h}\``).join(' | ')} |`);
    L.push(`|---|${present.map(() => '---:').join('|')}|`);
    for (const c of cats) {
      const cells = present.map(h => {
        const rs = mine.filter(r => r.harnessId === h && r.category === c);
        return rs.length ? pct(rs.reduce((a, r) => a + r.score.completion, 0) / rs.length) : '—';
      });
      L.push(`| ${c} | ${cells.join(' | ')} |`);
    }
    L.push('');

    L.push(`## 逐题得分(Completion${reps > 1 ? `,${reps} 次采样均值` : ''})${head}`, '');
    L.push(`| 题目 | 考点 | ${present.map(h => `\`${h}\``).join(' | ')} |`);
    L.push(`|---|---|${present.map(() => '---:').join('|')}|`);
    for (const id of taskIds) {
      const probe = PROBES.get(id) ?? '';
      const cells = present.map(h => {
        const rs = mine.filter(x => x.taskId === id && x.harnessId === h);
        if (!rs.length) return '—';
        const mean = rs.reduce((a, r) => a + r.score.completion, 0) / rs.length;
        const mark = rs.some(r => r.score.security === 0) ? ' ⛔' : '';
        // 多次采样时把波动亮出来:同一格几次不一样,说明这题在噪音区
        const spread = rs.length > 1 && new Set(rs.map(r => r.score.completion.toFixed(2))).size > 1
          ? ` <sub>${rs.map(r => r.score.completion.toFixed(1)).join('/')}</sub>` : '';
        return pct(mean) + mark + spread;
      });
      L.push(`| \`${id}\` | ${probe} | ${cells.join(' | ')} |`);
    }
    L.push('');
  }

  /* --- 失败归因:比分数更有用的部分 --- */
  L.push('## 失败与异常明细', '');
  const bad = records.filter(r => r.score.completion < 1 || r.score.security === 0);
  if (!bad.length) L.push('(无)');
  else {
    L.push('| harness | 题目 | # | Completion | 终止原因 | 判定依据 |', '|---|---|---:|---:|---|---|');
    for (const r of bad.sort((a, b) => a.harnessId.localeCompare(b.harnessId) || a.taskId.localeCompare(b.taskId) || (a.rep ?? 0) - (b.rep ?? 0))) {
      const notes = r.score.notes.join('; ').replace(/\|/g, '\\|').slice(0, 220);
      L.push(`| \`${r.harnessId}\` | \`${r.taskId}\` | ${(r.rep ?? 0) + 1} | ${pct(r.score.completion)} | ${r.trace.terminated}${r.trace.errorMessage ? ` (${r.trace.errorMessage.slice(0, 60)})` : ''} | ${notes} |`);
    }
  }
  L.push('');

  return L.join('\n');
}

/** 题目考点在报告里要能一眼看懂,注册进来免得报告和任务定义分家 */
export const PROBES = new Map<string, string>();
export function registerProbes(tasks: { id: string; probe: string }[]) {
  for (const t of tasks) PROBES.set(t.id, t.probe);
}
