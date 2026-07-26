/** harness #3:pi —— 真实第三方框架对照(github.com/earendil-works/pi,Mario Zechner)。
 *
 * 前三档都是本仓库的代码,同源难免同短板;接一个外部实现进来才知道差距是真是假。
 * Pi 的 `Agent` 是事件驱动的 agent loop:turn_start → LLM → 工具并行执行 → turn_end,
 * 带 transformContext 钩子(上下文裁剪)、beforeToolCall 门控、JSONL 会话树。
 *
 * 控变量的取舍(重要,看分之前先看这段):
 *   - **工具**:用本仓库的实现包装成 Pi 的 `AgentTool`,不用 Pi 自带的 read/write/edit/bash。
 *     两边语义本就一致(本仓库的工具面就是照 Pi 的结论设计的),换掉是为了让分差只反映编排层。
 *   - **提示词**:与 `my-agent` 用同一份 coding 提示词,不用 Pi CLI 自己那套。
 *   - **thinking**:统一关闭。
 *   所以这一档测的是 **Pi 的 agent loop**,不是"开箱即用的 Pi CLI"。后者分数可能更高,
 *   但那样就同时换了三个变量,分差归因不到任何一处。
 *
 * Pi 是可选依赖:没装就跳过这一档,不影响其它三档跑分。 */
import type { Harness, Trace, TraceStep } from '../types.js';
import { openWorkspace } from '../../../../apps/server/src/workspace.js';
import { activeTools, runTool } from '../../../../apps/server/src/tools/index.js';
import { buildSystemPrompt } from '../../../../apps/server/src/prompt.js';
import { withTimeout } from './raw.js';

export async function piAvailable(): Promise<boolean> {
  try { await import('@earendil-works/pi-agent-core'); return true; } catch { return false; }
}

export const piHarness: Harness = {
  id: 'pi',
  describe: 'Pi 的 agent loop(@earendil-works/pi-agent-core):事件驱动循环 + 工具并行执行 + 上下文钩子。工具与提示词换成本仓库同款以控变量。',

  async run(ctx): Promise<Trace> {
    const t0 = Date.now();
    const { Agent } = await import('@earendil-works/pi-agent-core');
    const { createModels } = await import('@earendil-works/pi-ai');
    const { deepseekProvider } = await import('@earendil-works/pi-ai/providers/deepseek');

    // Pi 从 DEEPSEEK_API_KEY 取 key;本仓库习惯叫 DS_API_KEY,这里桥接一下
    process.env.DEEPSEEK_API_KEY ??= process.env.PROVIDER_API_KEY ?? process.env.DS_API_KEY;

    const models = createModels();
    models.setProvider(deepseekProvider());
    const model = models.getModel('deepseek', ctx.model);
    if (!model) throw new Error(`Pi 不认识模型 ${ctx.model}(它的 deepseek provider 只登记了已知模型)`);

    const ws = await openWorkspace(ctx.workspaceDir);
    const steps: TraceStep[] = [];
    let toolCalls = 0, toolErrors = 0;

    const tools = activeTools('coding').map(def => ({
      name: def.name,
      label: def.name,
      description: def.description,
      // Pi 的类型标的是 TypeBox TSchema,但运行时只把它当 JSON Schema 转发给 API —— plain 对象实测可用
      parameters: def.parameters as any,
      async execute(_id: string, params: Record<string, unknown>) {
        const r = await runTool(def.name, params, {
          store: null as any, threadId: 'bench', turnId: 'bench', workspace: ws, progress: () => {},
        });
        toolCalls++;
        steps.push({ kind: 'tool', name: def.name, args: params, ok: r.ok, output: r.output });
        // Pi 的约定是"失败就抛,别把错误编码进 content";它会自己转成 tool result 回灌给模型
        if (!r.ok) { toolErrors++; throw new Error(String((r.output as any)?.error ?? 'tool failed')); }
        return { content: [{ type: 'text' as const, text: JSON.stringify(r.output).slice(0, 4000) }], details: r.output };
      },
    }));

    const hint = (await ws.list()).slice(0, 100).join('\n') || '(空目录)';
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt({ groups: ['coding'], workspaceHint: hint }),
        model,
        thinkingLevel: 'off',
        tools: tools as any,
      },
      streamFn: models.streamSimple.bind(models),
    });

    // 预算:Pi 没有 maxTurns 参数,自己数 turn_start,到点 abort
    let turns = 0;
    let hitBudget = false;
    agent.subscribe(e => {
      if (e.type === 'turn_start') {
        if (++turns > ctx.budget.maxSteps) { hitBudget = true; agent.abort(); }
      }
    });

    // 双保险。只靠 agent.abort() 挂过:HumanEval 跑分卡在最后 14 格不动,
    // 日志大小和 mtime 十几分钟纹丝不变 —— abort 没能把底下那次流式请求断掉。
    // 评测框架不能指望被测对象老实退出,所以外面再套一层 Promise.race 硬兜底。
    const timer = setTimeout(() => { try { agent.abort(); } catch { /* 尽力而为 */ } }, ctx.budget.timeoutMs);
    let errorMessage: string | undefined;
    try {
      await withTimeout(agent.prompt(ctx.task.prompt), ctx.budget.timeoutMs + 5_000);
    } catch (err: any) {
      errorMessage = String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }

    // 从 Pi 的消息树里抽 trace。它自带 usage 与成本核算,直接用。
    let llmCalls = 0, promptTokens = 0, completionTokens = 0, finalText = '';
    for (const m of agent.state.messages ?? []) {
      if ((m as any).role !== 'assistant') continue;
      llmCalls++;
      const u = (m as any).usage;
      // 口径对齐:Pi 把缓存命中的 prompt 记在 cacheRead、不算进 input,而其它三档取的是
      // DeepSeek 的 prompt_tokens(含缓存命中)。不加回去,Pi 的 token 会凭空少一大截 ——
      // 曾经因此得出"Pi 省 4.4 倍 token"的错误结论。
      if (u) {
        promptTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        completionTokens += u.output ?? 0;
      }
      const text = ((m as any).content ?? [])
        .filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('');
      if (text) finalText = text;
      steps.push({
        kind: 'llm', text,
        promptTokens: u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : undefined,
        completionTokens: u?.output,
      });
    }

    const wallMs = Date.now() - t0;
    const terminated: Trace['terminated'] =
      hitBudget ? 'max-steps'
      : wallMs >= ctx.budget.timeoutMs ? 'timeout'
      : errorMessage ? 'error'
      : 'stop';

    return { steps, finalText, llmCalls, toolCalls, toolErrors, promptTokens, completionTokens, wallMs, terminated, errorMessage };
  },
};
