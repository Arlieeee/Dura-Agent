/** harness #2:my-agent —— 被测的完整 harness。
 *
 * 相对 react-min 多出来的东西(也正是要证明其价值的东西):
 *   - 事件溯源:每步落日志,state = fold(events),重跑收敛而非重复
 *   - fold 的投影清洗:悬空 tool_call 被剔除,不会毒害后续请求(react-min 遇到就 400 死)
 *   - decide 纯函数编排 + 显式 step 预算
 *   - 分工具集的提示词 + 首步注入工作区清单
 *   - compaction 摘要锚点(长任务不爆上下文)
 * 走的是生产同一条 runTurn 代码路径,不是为跑分现搭的简化版。 */
import type { Harness, Trace, TraceStep } from '../types.js';
import { makeBenchProvider } from '../provider.js';
import { MemoryStore, eventId } from '../../../../apps/server/src/store.js';
import { runTurn, newThreadId, newTurnId } from '../../../../apps/server/src/engine/runner.js';
import { openWorkspace } from '../../../../apps/server/src/workspace.js';
import { withTimeout } from './raw.js';
import path from 'node:path';

export const myAgentHarness: Harness = {
  id: 'my-agent',
  describe: '完整 harness:事件溯源 + fold/decide + 投影清洗 + 瞬时故障重投 + 分场景提示词 + 工作区清单注入 + compaction。',

  async run(ctx): Promise<Trace> {
    const t0 = Date.now();
    const store = new MemoryStore();
    const ws = await openWorkspace(ctx.workspaceDir);
    const threadId = newThreadId();
    const turnId = newTurnId();

    await store.createThread(threadId, 'bench', 'bench-user');
    await store.append({ id: eventId(turnId, 'turn.started', 'init'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
    await store.append({ id: eventId(turnId, 'user.message', 'init'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text: ctx.task.prompt } });

    let terminated: Trace['terminated'] = 'stop';
    let errorMessage: string | undefined;
    const deadline = t0 + ctx.budget.timeoutMs;
    const deps = {
      store, provider: makeBenchProvider(ctx.model), toolset: 'coding', workspace: ws,
      maxSteps: ctx.budget.maxSteps,
      // 消融开关:BENCH_SUBAGENTS=0 关掉委派,用来量它到底省了多少上下文
      enableSubagents: process.env.BENCH_SUBAGENTS !== '0',
      // 记忆目录必须挂在本题的临时工作区里。用全局默认的话,上一题记下的东西会漏进下一题,
      // 每一格就不再是从同一份初始状态出发 —— 那评测就不成立了。
      // BENCH_MEMORY=0 完全关掉(默认给独立目录,等于有能力但没有历史)。
      memoryDir: process.env.BENCH_MEMORY === '0' ? null : path.join(ctx.workspaceDir, '.memory'),
    };

    // 重投循环 = 生产环境 dispatcher 的语义(inline 退避重投 / bullmq attempts)。
    // 不模拟它就等于把被测框架的恢复能力关掉了 —— runTurn 只在"可重试且未超上限"时抛,
    // 超上限它自己写 turn.finished 正常返回,所以这个循环不会空转。
    for (let attempt = 0; ; attempt++) {
      try {
        await withTimeout(runTurn(deps, threadId, turnId), Math.max(1000, deadline - Date.now()));
        break;
      } catch (err: any) {
        errorMessage = String(err?.message ?? err);
        const timedOut = /timeout/i.test(errorMessage) || Date.now() >= deadline;
        if (timedOut) { terminated = 'timeout'; break; }
        if (attempt >= 2) { terminated = 'error'; break; }
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }

    // 轨迹直接从事件日志重建——日志本来就是唯一真相,不需要另开一套埋点
    const events = await store.load(threadId);
    const steps: TraceStep[] = [];
    const byCallId = new Map<string, TraceStep>();
    let llmCalls = 0, toolCalls = 0, toolErrors = 0, promptTokens = 0, completionTokens = 0, cachedTokens = 0, finalText = '';

    for (const e of events) {
      const p = e.payload as any;
      switch (e.kind) {
        case 'assistant.message': {
          llmCalls++;
          promptTokens += p.usage?.prompt_tokens ?? 0;
          completionTokens += p.usage?.completion_tokens ?? 0;
          cachedTokens += p.usage?.cached_tokens ?? 0;
          if (p.text) finalText = String(p.text);
          steps.push({ kind: 'llm', text: p.text, promptTokens: p.usage?.prompt_tokens, completionTokens: p.usage?.completion_tokens, cachedTokens: p.usage?.cached_tokens });
          break;
        }
        case 'tool.call': {
          const step: TraceStep = { kind: 'tool', name: String(p.name), args: p.args };
          steps.push(step);
          byCallId.set(String(p.tool_call_id), step);
          break;
        }
        case 'tool.result': {
          toolCalls++;
          if (p.ok === false) toolErrors++;
          // 必须按 tool_call_id 认领。一轮有多个工具调用时事件是
          // call A → call B → result A → result B,"找最后一个没填结果的"会把 A 的结果记到 B 头上
          // —— 引擎本身是按 id 匹配的,错配只发生在这里的轨迹重建,但足以让人误诊。
          const step = byCallId.get(String(p.tool_call_id));
          if (step) { step.ok = p.ok !== false; step.output = p.output; }
          break;
        }
        case 'turn.finished':
          if (terminated === 'stop' && (p.reason === 'max-steps' || p.reason === 'error')) {
            terminated = p.reason === 'max-steps' ? 'max-steps' : 'error';
            errorMessage ??= p.message ? String(p.message) : undefined;
          }
          break;
        case 'turn.suspended':
          // coding 工具集里没有 client tool,真挂起说明模型跑偏了;记为未完成
          terminated = 'max-steps';
          steps.push({ kind: 'error', text: `意外挂起:${p.question}` });
          break;
      }
    }

    return { steps, finalText, llmCalls, toolCalls, toolErrors, promptTokens, completionTokens, cachedTokens, wallMs: Date.now() - t0, terminated, errorMessage };
  },
};
