/** delegate:把一个子目标交给子 agent 独立完成,只把结论收回来。
 *
 * 为什么需要它(DeerFlow 的洞察):长会话的上下文压力主要来自**过程**而不是结论。
 * compaction 是事后压缩——等历史堆起来了再摘要,信息已经损耗;
 * 委派是事前隔离——子 agent 读了 20 个文件、试错 5 次,父 agent 只看到一句"找到了,在 X"。
 *
 * 实现上不新增引擎概念:子 agent 就是**另一个 thread 里的一个普通 turn**,
 * 走同一套 fold/decide/事件日志,因此天然继承幂等、崩溃恢复与可审计性。
 * 隔离靠 thread 边界完成 —— fold 是按 thread 加载的,子 agent 的中间消息
 * 根本不会出现在父 turn 的投影里,不需要给 fold 加任何过滤逻辑。 */
import type { ToolFn } from './index.js';

/** 委派深度上限。子 agent 还能再委派,但不能无限套娃。 */
const MAX_DEPTH = Number(process.env.MAX_DELEGATE_DEPTH ?? 2);

export const depthOf = (threadId: string) => (threadId.match(/~sub/g) ?? []).length;

export const delegateTool: ToolFn = async (args, ctx) => {
  if (!ctx.spawn) throw new Error('当前运行环境未启用子 agent');
  const goal = String(args.goal ?? '').trim();
  if (!goal) throw new Error('goal 不能为空');

  const depth = depthOf(ctx.threadId);
  if (depth >= MAX_DEPTH) {
    throw new Error(`已达委派深度上限 ${MAX_DEPTH},请自己完成这个子任务`);
  }

  ctx.progress({ status: 'delegating', goal: goal.slice(0, 120), depth: depth + 1 });
  const r = await ctx.spawn(goal, { maxSteps: Number(args.max_steps ?? 8) });

  // 只回结论。子 agent 读了什么、试错几次,父 agent 一概不知道 —— 这正是委派的目的。
  return { goal, result: r.text, sub_llm_calls: r.llmCalls, sub_tool_calls: r.toolCalls };
};
