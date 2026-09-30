/** harness #1:react-min —— 教程里最常见的那个 20 行 agent 循环。
 *
 * 有工具、有循环,仅此而已。**刻意不做**的事(正是完整 harness 的增量):
 *   - 提示词只有一句,不讲工作方式、不注入工作区清单
 *   - 工具错误原样回传,不引导恢复
 *   - 消息历史无限增长,不压缩、不裁剪
 *   - 无事件日志、无幂等、无崩溃恢复
 * 它和 my-agent 共用同一套工具实现与同一个 provider,所以分差 = 编排层的价值。 */
import type { Harness, Trace, TraceStep } from '../types.js';
import { makeBenchProvider } from '../provider.js';
import { withTimeout } from './raw.js';
import { toolSpecs, runTool } from '../../../../apps/server/src/tools/index.js';
import { openWorkspace } from '../../../../apps/server/src/workspace.js';
import type { ChatMsg } from '../../../../packages/protocol/src/index.js';

const SYSTEM = '你是一个助手,可以调用工具完成任务。';

export const reactMinHarness: Harness = {
  id: 'react-min',
  describe: '极简 ReAct 循环:同一套工具 + while 循环。无提示词工程、无上下文管理、无恢复机制。',

  async run(ctx): Promise<Trace> {
    const t0 = Date.now();
    const provider = makeBenchProvider(ctx.model);
    const ws = await openWorkspace(ctx.workspaceDir);
    const tools = toolSpecs('coding');
    const steps: TraceStep[] = [];
    const msgs: ChatMsg[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: ctx.task.prompt },
    ];

    let llmCalls = 0, toolCalls = 0, toolErrors = 0, promptTokens = 0, completionTokens = 0, cachedTokens = 0;
    let finalText = '';
    let terminated: Trace['terminated'] = 'max-steps';
    const deadline = t0 + ctx.budget.timeoutMs;

    try {
      for (let step = 0; step < ctx.budget.maxSteps; step++) {
        if (Date.now() > deadline) { terminated = 'timeout'; break; }

        const out = await withTimeout(provider.chat(msgs, tools, () => {}), Math.max(1000, deadline - Date.now()));
        llmCalls++;
        promptTokens += out.usage?.prompt_tokens ?? 0;
        completionTokens += out.usage?.completion_tokens ?? 0;
        cachedTokens += out.usage?.cached_tokens ?? 0;
        steps.push({ kind: 'llm', text: out.text, promptTokens: out.usage?.prompt_tokens, completionTokens: out.usage?.completion_tokens, cachedTokens: out.usage?.cached_tokens });
        if (out.text) finalText = out.text;

        msgs.push({
          role: 'assistant', content: out.text,
          reasoning_content: out.reasoning, tool_calls: out.tool_calls.length ? out.tool_calls : undefined,
        });

        if (!out.tool_calls.length) { terminated = 'stop'; break; }

        for (const call of out.tool_calls) {
          const r = await runTool(call.name, call.args, {
            store: null as any, threadId: 'bench', turnId: 'bench', workspace: ws, progress: () => {},
          });
          toolCalls++;
          if (!r.ok) toolErrors++;
          steps.push({ kind: 'tool', name: call.name, args: call.args, ok: r.ok, output: r.output });
          msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r.output).slice(0, 4000) });
        }
      }
    } catch (err: any) {
      const timeout = /timeout/i.test(String(err?.message));
      steps.push({ kind: 'error', text: String(err?.message ?? err) });
      return {
        steps, finalText, llmCalls, toolCalls, toolErrors, promptTokens, completionTokens, cachedTokens,
        wallMs: Date.now() - t0, terminated: timeout ? 'timeout' : 'error', errorMessage: String(err?.message ?? err),
      };
    }

    return { steps, finalText, llmCalls, toolCalls, toolErrors, promptTokens, completionTokens, cachedTokens, wallMs: Date.now() - t0, terminated };
  },
};
