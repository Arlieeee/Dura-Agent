/** turn 控制面:喊停(进行中 / 挂起中 / 连带子 agent)与同 thread 串行。脚本化 provider,零 API 成本。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMsg, ChatResult, ToolSpec, ChatDelta } from '../../../packages/protocol/src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';
import { MemoryStore, eventId } from '../src/store.js';
import { runTurn, cancelTurn, newTurnId } from '../src/engine/runner.js';
import { openWorkspace } from '../src/workspace.js';

const usage = { prompt_tokens: 10, completion_tokens: 5 };

/** 一直流不完,直到被 abort。 */
function hangUntilAborted(signal?: AbortSignal): Promise<ChatResult> {
  return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
/** started 在第一次被调用时 resolve。 */
class HangingProvider implements ChatProvider {
  name = 'hanging';
  private go!: () => void;
  started = new Promise<void>(r => { this.go = r; });
  chat(_m: ChatMsg[], _t: ToolSpec[], _d: (d: ChatDelta) => void, signal?: AbortSignal) { this.go(); return hangUntilAborted(signal); }
  async summarize() { return ''; }
}

async function withFixture(fn: (store: MemoryStore, ws: Awaited<ReturnType<typeof openWorkspace>>) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'turnctl-'));
  try { await fn(new MemoryStore(), await openWorkspace(dir)); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function seed(store: MemoryStore, threadId: string, turnId: string, text: string) {
  await store.createThread(threadId, 't', 'u');
  await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
  await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text } });
}
const finishReason = async (store: MemoryStore, threadId: string) =>
  (await store.load(threadId)).find(e => e.kind === 'turn.finished')?.payload.reason;

test('喊停进行中的 turn:流被打断,收尾成 cancelled,不记 turn.error', async () => {
  await withFixture(async (store, ws) => {
    const provider = new HangingProvider();
    const threadId = 'thr_c1'; const turnId = newTurnId();
    await seed(store, threadId, turnId, '写个长篇');
    const run = runTurn({ store, provider, toolset: 'coding', workspace: ws }, threadId, turnId);
    await provider.started;
    await cancelTurn(store, threadId, turnId);
    await run;
    assert.equal(await finishReason(store, threadId), 'cancelled');
    assert.equal((await store.load(threadId)).filter(e => e.kind === 'turn.error').length, 0);
  });
});

test('喊停挂起中的 turn:没有 runner 在跑,kick 一次就收敛', async () => {
  await withFixture(async (store, ws) => {
    const provider: ChatProvider = {
      name: 'asker', summarize: async () => '',
      chat: async () => ({ text: '', usage, tool_calls: [{ id: 'ask1', name: 'ask_user', args: { question: '选哪个?' } }] }),
    };
    const threadId = 'thr_c2'; const turnId = newTurnId();
    await seed(store, threadId, turnId, '帮我挑');
    await runTurn({ store, provider, toolset: 'chat', workspace: ws }, threadId, turnId);
    assert.equal((await store.getTurn(turnId))?.state, 'suspended');

    await cancelTurn(store, threadId, turnId);
    await runTurn({ store, provider, toolset: 'chat', workspace: ws }, threadId, turnId);
    assert.equal(await finishReason(store, threadId), 'cancelled');
  });
});

test('喊停父 turn 连带停掉正在跑的子 agent', async () => {
  await withFixture(async (store, ws) => {
    const childGoal = '慢慢查';
    let childStarted!: () => void;
    const childRunning = new Promise<void>(r => { childStarted = r; });
    const provider: ChatProvider = {
      name: 'family', summarize: async () => '',
      chat: async (msgs, _t, _d, signal) => {
        if (msgs.some(m => m.role === 'user' && m.content === childGoal)) { childStarted(); return hangUntilAborted(signal); }
        if (msgs.some(m => m.role === 'tool')) return { text: '收到', tool_calls: [], usage };
        return { text: '', usage, tool_calls: [{ id: 'dlg1', name: 'delegate', args: { goal: childGoal } }] };
      },
    };
    const threadId = 'thr_c3'; const turnId = newTurnId();
    await seed(store, threadId, turnId, '派个活');
    const run = runTurn({ store, provider, toolset: 'coding', workspace: ws, maxSteps: 4 }, threadId, turnId);
    await childRunning;
    await cancelTurn(store, threadId, turnId);
    await run;
    assert.equal(await finishReason(store, `${threadId}~sub_dlg1`), 'cancelled');
    assert.equal(await finishReason(store, threadId), 'cancelled');
  });
});

test('同一 turn 被并发 kick 两次:LLM 每次给的 tool_call_id 不同,副作用也只发生一次', async () => {
  await withFixture(async (store, ws) => {
    // 真实模型每次调用都给新 id —— 确定性事件 ID 去不了这种重,只有同 thread 串行挡得住
    class FreshIds implements ChatProvider {
      name = 'fresh'; calls = 0;
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        this.calls++;
        if (msgs.some(m => m.role === 'tool')) return { text: '已记账', tool_calls: [], usage };
        return { text: '', usage, tool_calls: [{ id: `call_${randomUUID().slice(0, 8)}`, name: 'write_file', args: { path: 'ledger.txt', content: 'charged\n' } }] };
      }
      async summarize() { return ''; }
    }
    const [p1, p2] = [new FreshIds(), new FreshIds()];
    const threadId = 'thr_c4'; const turnId = newTurnId();
    await seed(store, threadId, turnId, '记一笔');
    await Promise.all([
      runTurn({ store, provider: p1, toolset: 'coding', workspace: ws }, threadId, turnId),
      runTurn({ store, provider: p2, toolset: 'coding', workspace: ws }, threadId, turnId),
    ]);
    const events = await store.load(threadId);
    assert.equal(events.filter(e => e.kind === 'tool.call').length, 1);
    assert.equal(p1.calls + p2.calls, 2);
  });
});
