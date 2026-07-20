/** decide(state) → command:Agent 的全部"编排智能",纯函数、无 I/O、可单测可回放。 */
import type { ToolCallReq } from '../../../../packages/protocol/src/index.js';
import type { TurnState } from './fold.js';
import { isClientTool } from '../tools/index.js';

export type Command =
  | { type: 'call_llm' }
  | { type: 'execute_tool'; call: ToolCallReq }
  | { type: 'suspend'; call: ToolCallReq }
  | { type: 'idle'; reason: 'stop' | 'max-steps' }
  | { type: 'noop' };            // 已挂起/已结束:什么都不做,等新事件

const MAX_STEPS = 12;

export function decide(state: TurnState): Command {
  if (state.status === 'finished') return { type: 'noop' };
  if (state.suspended) return { type: 'noop' };                    // 挂起中,等 user.confirmation 事件
  if (state.step >= MAX_STEPS) return { type: 'idle', reason: 'max-steps' };

  // 有未完成的工具调用:client tool → 挂起;server tool → 执行
  const next = state.pendingCalls[0];
  if (next) return isClientTool(next.name) ? { type: 'suspend', call: next } : { type: 'execute_tool', call: next };

  // 无 pending:看最后一条消息决定是否继续叫 LLM
  const last = state.msgs[state.msgs.length - 1];
  if (!last) return { type: 'idle', reason: 'stop' };
  if (last.role === 'user' || last.role === 'tool') return { type: 'call_llm' };  // 有新输入 → 想
  if (last.role === 'assistant' && !last.tool_calls?.length) return { type: 'idle', reason: 'stop' }; // 纯文本收尾
  return { type: 'idle', reason: 'stop' };
}
