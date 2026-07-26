/** decide(state) → command:Agent 的全部"编排智能",纯函数、无 I/O、可单测可回放。 */
import type { ToolCallReq } from '../../../../packages/protocol/src/index.js';
import type { TurnState } from './fold.js';
import { isClientTool, isParallelSafe } from '../tools/index.js';

export type Command =
  | { type: 'call_llm' }
  | { type: 'execute_tools'; calls: ToolCallReq[] }   // 一批;长度 1 即串行
  | { type: 'suspend'; call: ToolCallReq }
  | { type: 'idle'; reason: 'stop' | 'max-steps' }
  | { type: 'noop' };            // 已挂起/已结束:什么都不做,等新事件

/** 单 turn 最多几轮 LLM 调用。评测要固定 budget,所以可覆盖(MAX_STEPS env 或显式传参)。 */
export const DEFAULT_MAX_STEPS = Number(process.env.MAX_STEPS ?? 12);

export function decide(state: TurnState, maxSteps = DEFAULT_MAX_STEPS): Command {
  if (state.status === 'finished') return { type: 'noop' };
  if (state.suspended) return { type: 'noop' };                    // 挂起中,等 user.confirmation 事件
  if (state.step >= maxSteps) return { type: 'idle', reason: 'max-steps' };

  // 有未完成的工具调用:client tool → 挂起;server tool → 执行
  const next = state.pendingCalls[0];
  if (next) {
    if (isClientTool(next.name)) return { type: 'suspend', call: next };

    // 攒一批:从头取连续的 server tool,遇到 client tool 就停(它得单独挂起)
    const batch: ToolCallReq[] = [];
    for (const c of state.pendingCalls) {
      if (isClientTool(c.name)) break;
      batch.push(c);
    }
    // 只在整批都是只读工具时才并行。写文件/跑命令之间可能有隐含依赖
    // (先 mkdir 再写入),模型一次发出来不等于它们真能同时跑 —— 宁可慢,不能错。
    const parallel = batch.length > 1 && batch.every(c => isParallelSafe(c.name));
    return { type: 'execute_tools', calls: parallel ? batch : [batch[0]] };
  }

  // 无 pending:看最后一条消息决定是否继续叫 LLM
  const last = state.msgs[state.msgs.length - 1];
  if (!last) return { type: 'idle', reason: 'stop' };
  if (last.role === 'user' || last.role === 'tool') return { type: 'call_llm' };  // 有新输入 → 想
  if (last.role === 'assistant' && !last.tool_calls?.length) return { type: 'idle', reason: 'stop' }; // 纯文本收尾
  return { type: 'idle', reason: 'stop' };
}
