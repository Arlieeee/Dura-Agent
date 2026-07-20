/** runner:执行 decide 产出的命令,结果作为新事件追加回日志。每轮重新 fold,恢复=正常路径。 */
import { randomUUID } from 'node:crypto';
import type { AgentEvent, Chunk } from '../../../../packages/protocol/src/index.js';
import type { EventStore } from '../store.js';
import { eventId } from '../store.js';
import { fold } from './fold.js';
import { decide } from './decide.js';
import { TOOL_SPECS, runTool } from '../tools/index.js';
import type { ChatProvider } from '../llm/provider.js';
import { bus } from '../bus.js';
import { loadSkills } from '../skills.js';

const COMPACT_THRESHOLD = Number(process.env.COMPACT_THRESHOLD ?? 30);

export interface RunnerDeps { store: EventStore; provider: ChatProvider }

export async function runTurn(deps: RunnerDeps, threadId: string, turnId: string): Promise<void> {
  const { store, provider } = deps;
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
    console.error(`[runner] turn ${turnId} 失败:`, err?.message ?? err);
    await append('turn.finished', 'fin', { reason: 'error', message: String(err?.message ?? err).slice(0, 500) });
    await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'failed' });
    emit({ type: 'finish', finish_reason: 'error' });
    return;
  } finally {
    clearInterval(hb);
  }

  async function runLoop() {
  for (let iter = 0; iter < 30; iter++) {
    await store.upsertTurn({ id: turnId, thread_id: threadId, heartbeat_at: Date.now() });

    const events = await store.load(threadId);
    const state = fold(events, turnId);
    const cmd = decide(state);

    switch (cmd.type) {
      case 'call_llm': {
        const skills = await loadSkills();
        const system = [
          '你是 dura-agent,一个会用工具完成任务的中文助手。需求不明确时用 ask_user 澄清;要输出长内容时用 write_document 生成在线文档。',
          state.summary ? `【此前对话摘要】${state.summary}` : '',
          skills ? `【可用技能】\n${skills}` : '',
        ].filter(Boolean).join('\n\n');

        const step = state.step;
        const out = await provider.chat(
          [{ role: 'system', content: system }, ...state.msgs], TOOL_SPECS,
          d => {
            if (d.kind === 'text') emit({ type: 'text-delta', step, delta: d.delta });
            else if (d.kind === 'reasoning') emit({ type: 'reasoning-delta', step, delta: d.delta });
            else if (d.kind === 'tool-start') emit({ type: 'tool-input-start', step, tool_call_id: d.id, tool_name: d.name });
            else if (d.kind === 'tool-args') emit({ type: 'tool-input-delta', tool_call_id: d.id, tool_name: d.name, chars: d.chars });
          });

        await append('assistant.message', `step${step}`, { step, text: out.text, reasoning: out.reasoning, usage: out.usage });
        if (out.usage) emit({ type: 'usage', step, prompt_tokens: out.usage.prompt_tokens, completion_tokens: out.usage.completion_tokens });
        for (const call of out.tool_calls) {
          await append('tool.call', call.id, { step, tool_call_id: call.id, name: call.name, args: call.args });
          emit({ type: 'tool-input-available', step, tool_call_id: call.id, tool_name: call.name, input: call.args });
        }
        break;
      }
      case 'execute_tool': {
        const { call } = cmd;
        const r = await runTool(call.name, call.args, {
          store, threadId, turnId, progress: data => emit({ type: 'tool-progress', tool_call_id: call.id, data }),
        });
        await append('tool.result', call.id, { tool_call_id: call.id, name: call.name, ok: r.ok, output: r.output });
        emit({ type: 'tool-output-available', tool_call_id: call.id, output: r.output, ok: r.ok });
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
