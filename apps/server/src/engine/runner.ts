/** runner:执行 decide 产出的命令,结果作为新事件追加回日志。每轮重新 fold,恢复=正常路径。 */
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Chunk } from '../../../../packages/protocol/src/index.js';
import type { EventStore } from '../store.js';
import { eventId } from '../store.js';
import { fold } from './fold.js';
import { decide, DEFAULT_MAX_STEPS } from './decide.js';
import { activeTools, toolSpecs, runTool, type SpawnFn } from '../tools/index.js';
import { depthOf } from '../tools/delegate.js';
import type { ChatProvider } from '../llm/provider.js';
import { bus } from '../bus.js';
import { loadSkills, skillToolAllowList } from '../skills.js';
import { threadWorkspace, type Workspace } from '../workspace.js';
import { buildSystemPrompt } from '../prompt.js';
import { MemoryDir } from '../memory.js';
import { makeExecutor, type Executor } from '../executor.js';

const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD ?? 30);
const MAX_DELEGATE_DEPTH = Number(process.env.MAX_DELEGATE_DEPTH ?? 2);
/** 同一 turn 最多重投几次。超过就认命,写 turn.finished 免得坏消息在队列里无限打转。 */
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);

/** 瞬时故障 vs 终态故障。
 *  分错的代价是不对称的:把瞬时当终态 → turn 永久死亡(写了 turn.finished 就再也重投不回来);
 *  把终态当瞬时 → 白重试几次而已。所以拿不准时按可重试处理。 */
export function isRetryable(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  if (/^LLM (4\d\d)/.test(msg)) return /^LLM (408|409|425|429)/.test(msg);  // 4xx 是自己请求有问题,除了这几个
  if (/^LLM 5\d\d/.test(msg)) return true;                                  // 5xx 是对面的问题
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network/i.test(msg)) return true;
  return true;
}

export interface RunnerDeps {
  store: EventStore;
  provider: ChatProvider;
  /** 覆盖工具集(bench 用);不传则读 TOOLSET env */
  toolset?: string;
  /** 覆盖工作区(bench 用:每题一个预置好初始状态的临时目录);不传则按 thread 建 */
  workspace?: Workspace;
  /** 单 turn 的 LLM 调用预算;不传则读 MAX_STEPS env(默认 12) */
  maxSteps?: number;
  /** 关掉子 agent(评测做消融用);默认开 */
  enableSubagents?: boolean;
  /** 跨 session 记忆目录。传 null 显式关闭(评测做消融用);不传则用 MEMORY_ROOT。 */
  memoryDir?: string | null;
  /** 命令执行环境:'local'(默认)| 'docker'。也可直接传一个现成的执行器复用容器。 */
  sandbox?: 'local' | 'docker' | Executor;
}

export async function runTurn(deps: RunnerDeps, threadId: string, turnId: string): Promise<void> {
  const { store, provider } = deps;
  const canSpawn = deps.enableSubagents !== false && depthOf(threadId) < MAX_DELEGATE_DEPTH;
  // 先算出本场景本来有哪些工具,再让技能在这个范围内收窄 —— 与本场景无关的技能不参与
  const memory = deps.memoryDir === null ? undefined : await new MemoryDir(deps.memoryDir).ensure();
  const workspace = deps.workspace ?? await threadWorkspace(threadId);
  // 执行器挂在工作区上,所以必须等 workspace 定下来
  const executor = typeof deps.sandbox === 'object' ? deps.sandbox : await makeExecutor(workspace.root, deps.sandbox);
  const ownsExecutor = typeof deps.sandbox !== 'object';    // 复用传进来的容器时不由这里销毁
  const baseNames = activeTools(deps.toolset, { spawn: canSpawn, memory: !!memory }).map(t => t.name);
  const allow = await skillToolAllowList(baseNames);
  const filter = { spawn: canSpawn, allow, memory: !!memory };
  const tools = toolSpecs(deps.toolset, filter);
  const groups = [...new Set(activeTools(deps.toolset, filter).map(t => t.group))];
  const emit = (c: Chunk) => bus.emit(threadId, c);
  const append = async (kind: AgentEvent['kind'], key: string, payload: Record<string, unknown>) => {
    const inserted = await store.append({ id: eventId(turnId, kind, key), thread_id: threadId, turn_id: turnId, kind, payload });
    if (!inserted) console.log(`[runner] 幂等命中(no-op): ${kind}/${key}`);
    return inserted;
  };

  await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'running', heartbeat_at: Date.now() });
  // 真·心跳:独立定时器,LLM 长生成(30s+)期间也持续报活,否则 sweeper 会误判丢失而重投
  const hb = setInterval(() => {
    void store.upsertTurn({ id: turnId, thread_id: threadId, heartbeat_at: Date.now() }).catch(() => {});
  }, 5_000);

  try {
    await runLoop();
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 500);
    const attempts = fold(await store.load(threadId), turnId).attempts;
    const retryable = isRetryable(err) && attempts + 1 < MAX_ATTEMPTS;

    if (retryable) {
      // 关键:**不写 turn.finished**。写了 fold 就判 finished,重投只会得到 noop —— turn 永久死亡。
      // 只留一条 turn.error 计数,turn 保持可执行;已完成的步骤靠确定性 ID 在重跑时 no-op。
      console.warn(`[runner] turn ${turnId} 第 ${attempts + 1} 次失败(可重试):${message}`);
      await append('turn.error', `attempt${attempts}`, { message, retryable: true });
      await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'pending', heartbeat_at: 0 });
      throw err;                       // 冒泡给队列/调用方触发重投;sweeper 也会兜底
    }

    console.error(`[runner] turn ${turnId} 终态失败(第 ${attempts + 1} 次):`, message);
    await append('turn.finished', 'fin', { reason: 'error', message });
    await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'failed' });
    emit({ type: 'finish', finish_reason: 'error' });
    return;
  } finally {
    clearInterval(hb);
    if (ownsExecutor) await executor.dispose().catch(() => {});
  }

  async function runLoop() {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  // 一次 LLM 调用最多带出 N 个工具调用,每个占一次迭代 → 上限给 steps 的数倍留余量
  for (let iter = 0; iter < maxSteps * 4; iter++) {
    await store.upsertTurn({ id: turnId, thread_id: threadId, heartbeat_at: Date.now() });

    const events = await store.load(threadId);
    const state = fold(events, turnId);
    const cmd = decide(state, maxSteps);

    switch (cmd.type) {
      case 'call_llm': {
        // 工作区清单只在 coding 模式、且首步注入:让模型开局就知道有哪些文件,省掉一轮 list_files
        const hint = groups.includes('coding') && state.step === 0
          ? (await workspace.list()).slice(0, 100).join('\n') || '(空目录)'
          : undefined;
        // 索引常驻 + 对本轮输入自动预取相关正文。只给索引的话模型不会主动去 recall(实测)
        const firstUser = state.msgs.find(m => m.role === 'user')?.content ?? '';
        const memoryHint = memory && state.step === 0 ? await memory.contextFor(firstUser) : undefined;
        const system = buildSystemPrompt({
          groups, summary: state.summary, skills: await loadSkills(),
          workspaceHint: hint, memoryHint,
        });

        const step = state.step;
        const out = await provider.chat(
          [{ role: 'system', content: system }, ...state.msgs], tools,
          d => {
            if (d.kind === 'text') emit({ type: 'text-delta', step, delta: d.delta });
            else if (d.kind === 'reasoning') emit({ type: 'reasoning-delta', step, delta: d.delta });
            else if (d.kind === 'tool-start') emit({ type: 'tool-input-start', step, tool_call_id: d.id, tool_name: d.name });
            else if (d.kind === 'tool-args') emit({ type: 'tool-input-delta', tool_call_id: d.id, tool_name: d.name, chars: d.chars });
          });

        // 重放识别:重投后模型会照着 fold 出的历史把已做过的步骤再说一遍。这些步骤的 tool.call
        // 都会幂等 no-op,若还给它写一条 assistant.message,日志里就多出一条光杆消息,还白占一格 step 预算。
        const isReplay = !out.text && !out.reasoning && out.tool_calls.length > 0
          && out.tool_calls.every(c => state.seenCallIds.has(c.id));
        if (!isReplay) {
          await append('assistant.message', `step${step}`, { step, text: out.text, reasoning: out.reasoning, usage: out.usage });
          if (out.usage) emit({ type: 'usage', step, prompt_tokens: out.usage.prompt_tokens, completion_tokens: out.usage.completion_tokens });
        }
        for (const call of out.tool_calls) {
          await append('tool.call', call.id, { step, tool_call_id: call.id, name: call.name, args: call.args });
          emit({ type: 'tool-input-available', step, tool_call_id: call.id, tool_name: call.name, input: call.args });
        }
        break;
      }
      case 'execute_tools': {
        // 一批只读工具并发跑(decide 已经保证同批无副作用);批里只有一个时就是串行
        const results = await Promise.all(cmd.calls.map(call =>
          runTool(call.name, call.args, {
            store, threadId, turnId, workspace, allowedTools: allow, memory, executor,
            progress: data => emit({ type: 'tool-progress', tool_call_id: call.id, data }),
            spawn: canSpawn ? makeSpawn(deps, threadId, workspace, call.id, executor) : undefined,
          })));
        // 落盘严格按模型给出的顺序,不按完成顺序 —— 否则同一批的日志顺序随机,fold 就不确定了
        for (let i = 0; i < cmd.calls.length; i++) {
          const call = cmd.calls[i]; const r = results[i];
          await append('tool.result', call.id, { tool_call_id: call.id, name: call.name, ok: r.ok, output: r.output });
          emit({ type: 'tool-output-available', tool_call_id: call.id, output: r.output, ok: r.ok });
        }
        break;
      }
      case 'suspend': {
        const { call } = cmd;
        await append('turn.suspended', call.id, {
          tool_call_id: call.id, name: call.name,
          question: String(call.args.question ?? '请确认'), options: call.args.options,
        });
        await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'suspended' });
        emit({ type: 'suspend', tool_call_id: call.id, question: String(call.args.question ?? ''), options: call.args.options as string[] | undefined });
        emit({ type: 'finish', finish_reason: 'tool-calls' });
        return;
      }
      case 'idle': {
        await append('turn.finished', 'fin', { reason: cmd.reason });
        await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'completed' });
        emit({ type: 'finish', finish_reason: cmd.reason });
        await maybeCompact(deps, threadId, turnId);
        return;
      }
      case 'noop': {
        // 重复 kick(重放/竞态)会把 state 置成 running 才发现无事可做:按账本收敛回去,否则 bullmq 的 sweeper 会无限重投
        await store.upsertTurn({ id: turnId, thread_id: threadId, state: state.status === 'suspended' ? 'suspended' : 'completed' });
        return;
      }
    }
  }
  await append('turn.finished', 'fin', { reason: 'max-steps' });
  await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'completed' });
  emit({ type: 'finish', finish_reason: 'max-steps' });
  }
}

/** 造一个子 agent 入口交给 delegate 工具。
 *
 * 子 agent = **另一个 thread 里的一个普通 turn**,复用同一个 runTurn、同一个工作区。
 * 隔离靠 thread 边界:fold 是按 thread 加载事件的,所以子 agent 的中间消息不可能
 * 出现在父 turn 的投影里 —— 不需要给 fold 加任何过滤。
 *
 * ID 必须确定性:父 turn 重放时会重新调用同一个 delegate,若子 thread ID 随机,
 * 整个子任务会被重跑一遍。用父 turn + tool_call_id 派生,配合事件层幂等即可收敛。 */
function makeSpawn(deps: RunnerDeps, parentThreadId: string, workspace: Workspace, callId: string, executor: Executor): SpawnFn {
  return async (goal, opts) => {
    const subThreadId = `${parentThreadId}~sub_${callId}`;
    const subTurnId = `trn_${callId}`;
    const { store } = deps;

    await store.createThread(subThreadId, `子任务:${goal.slice(0, 40)}`, 'subagent').catch(() => {});
    await store.append({ id: eventId(subTurnId, 'turn.started', 'init'), thread_id: subThreadId, turn_id: subTurnId, kind: 'turn.started', payload: {} });
    await store.append({ id: eventId(subTurnId, 'user.message', 'init'), thread_id: subThreadId, turn_id: subTurnId, kind: 'user.message', payload: { text: goal } });

    // 同一个工作区 + **同一个执行器**:子 agent 干的活要对父 agent 可见(它们在协作,不是各做各的);
    // 传执行器实例而不是字符串,docker 模式下才不会为每个子 agent 另起一个容器。
    await runTurn({
      ...deps, workspace, sandbox: executor,
      maxSteps: opts?.maxSteps ?? 8, toolset: opts?.toolset ?? deps.toolset,
    }, subThreadId, subTurnId);

    const st = fold(await store.load(subThreadId), subTurnId);
    const text = [...st.msgs].reverse().find(m => m.role === 'assistant' && m.content)?.content ?? '';
    const llmCalls = st.msgs.filter(m => m.role === 'assistant').length;
    const toolCalls = st.msgs.filter(m => m.role === 'tool').length;
    return { text: text || '(子 agent 没有给出结论)', llmCalls, toolCalls };
  };
}

async function maybeCompact(deps: RunnerDeps, threadId: string, turnId: string) {
  const events = await deps.store.load(threadId);
  const state = fold(events, turnId);
  if (state.eventCount < COMPACT_THRESHOLD) return;
  const text = state.msgs.map(m => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');
  const summary = ((state.summary ? state.summary + '\n' : '') + await deps.provider.summarize(text)).slice(0, 2000);
  const last = events[events.length - 1];
  await deps.store.append({
    id: eventId(turnId, 'compaction.summary', String(last?.seq ?? events.length)),
    thread_id: threadId, turn_id: turnId, kind: 'compaction.summary',
    payload: { upto_event_id: last?.id, summary },
  });
  console.log(`[compaction] thread=${threadId} 折叠 ${state.eventCount} 事件 → 摘要锚点`);
}

export const newTurnId = () => 'trn_' + randomUUID().slice(0, 8);
export const newThreadId = () => 'thr_' + randomUUID().slice(0, 8);
