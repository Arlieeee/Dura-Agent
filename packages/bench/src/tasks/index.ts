/** 任务集清单。加题只需在这里 push,runner/评分/报告都不用改。 */
import type { BenchTask } from '../types.js';
import { codingTasks } from './coding.js';
import { dataTasks } from './data.js';
import { behaviorTasks } from './behavior.js';
import { hardTasks } from './hard.js';
import { contextTasks } from './context.js';
import { humanEvalTasks, humanEvalAvailable } from './humaneval.js';
import { sweBenchTasks, sweBenchAvailable } from './swebench.js';

/** 自建任务集:离线、确定性、每题一个 oracle */
export const allTasks: BenchTask[] = [...codingTasks, ...dataTasks, ...behaviorTasks, ...hardTasks, ...contextTasks];

/** 公开数据集需要显式点名(--tasks humaneval),不混进默认全量跑分:
 *  它们量大、判分要外部运行时,和自建题的成本量级不是一回事。 */
export function externalTasks(name: string, limit?: number): BenchTask[] {
  if (name.startsWith('humaneval')) {
    if (!humanEvalAvailable()) {
      console.warn('⚠ 未找到 HumanEval 数据,先跑:node scripts/fetch-datasets.mjs humaneval');
      return [];
    }
    const m = /^humaneval:(\d+)$/.exec(name);
    return humanEvalTasks(limit ?? (m ? Number(m[1]) : 20));
  }
  if (name.startsWith('swebench')) {
    if (!sweBenchAvailable()) {
      console.warn('⚠ 未找到 SWE-bench 数据,先跑:node scripts/fetch-datasets.mjs swebench');
      return [];
    }
    const m = /^swebench:(\d+)$/.exec(name);
    return sweBenchTasks(limit ?? (m ? Number(m[1]) : 10));
  }
  return [];
}

export function selectTasks(filter?: string): BenchTask[] {
  if (!filter) return allTasks;
  const keys = filter.split(',').map(s => s.trim()).filter(Boolean);
  const out: BenchTask[] = [];
  for (const k of keys) {
    if (k.startsWith('humaneval') || k.startsWith('swebench')) { out.push(...externalTasks(k)); continue; }
    out.push(...allTasks.filter(t => t.id === k || t.id.startsWith(k) || t.category === k));
  }
  // 同一题被多个 key 命中时只留一份
  return [...new Map(out.map(t => [t.id, t])).values()];
}
