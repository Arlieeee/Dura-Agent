/** 子 agent 委派:隔离性、深度上限、重放幂等。全部用脚本化 provider,零 API 成本。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMsg, ChatResult, ToolSpec } from '../../../packages/protocol/src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';
import { MemoryStore, eventId } from '../src/store.js';
import { runTurn, newTurnId } from '../src/engine/runner.js';
import { fold } from '../src/engine/fold.js';
import { openWorkspace } from '../src/workspace.js';
import { toolSpecs } from '../src/tools/index.js';
import { depthOf } from '../src/tools/delegate.js';

/** 靠"最近一条 user 说了什么"分辨自己在扮演父还是子 agent */
class RoleProvider implements ChatProvider {
  name = 'role';
  parentCalls = 0; childCalls = 0;
  constructor(private childGoal: string) {}
  async chat(msgs: ChatMsg[], _t: ToolSpec[]): Promise<ChatResult> {
    const firstUser = msgs.find(m => m.role === 'user')?.content ?? '';
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    if (firstUser.includes(this.childGoal)) {
      // 子 agent:先翻文件,再给结论
      const n = ++this.childCalls;
      if (n === 1) return { text: '', usage, tool_calls: [{ id: 'kid1', name: 'list_files', args: {} }] };
      if (n === 2) return { text: '', usage, tool_calls: [{ id: 'kid2', name: 'read_file', args: { path: 'a.txt' } }] };
      return { text: '数完了:2 个文件', tool_calls: [], usage };
    }
    // 父 agent:把活派出去,然后收结论
    const n = ++this.parentCalls;
    if (n === 1) return { text: '', usage, tool_calls: [{ id: 'p1', name: 'delegate', args: { goal: this.childGoal } }] };
    return { text: '子任务回报完毕', tool_calls: [], usage };
  }
  async summarize() { return ''; }
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'subagent-'));
  const ws = await openWorkspace(dir);
  await ws.write('a.txt', 'alpha');
  await ws.write('b.txt', 'beta');
  return { ws, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function seed(store: MemoryStore, threadId: string, turnId: string, text: string) {
  await store.createThread(threadId, 't', 'u');
  await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
  await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text } });
}

test('委派:子 agent 的中间过程不进父上下文,只回结论', async () => {
  const { ws, cleanup } = await fixture();
  try {
    const store = new MemoryStore();
    const provider = new RoleProvider('数一下有几个文件');
    const threadId = 'thr_parent'; const turnId = newTurnId();
    await seed(store, threadId, turnId, '帮我数文件');
    await runTurn({ store, provider, toolset: 'coding', workspace: ws, maxSteps: 6 }, threadId, turnId);

    const parentEvents = await store.load(threadId);
    const parentToolNames = parentEvents.filter(e => e.kind === 'tool.call').map(e => (e.payload as any).name);
    // 父 thread 里只该看到 delegate 这一次调用,子 agent 翻文件的动作一概不可见
    assert.deepEqual(parentToolNames, ['delegate']);

    const st = fold(parentEvents, turnId);
    const flat = JSON.stringify(st.msgs);
    assert.ok(!flat.includes('list_files'), '父上下文混入了子 agent 的工具调用');
    assert.ok(flat.includes('数完了:2 个文件'), '父上下文里应当能看到子 agent 的结论');

    // 子 agent 的完整轨迹仍然落了库 —— 隔离的是上下文,不是审计
    const subThreadId = `${threadId}~sub_p1`;
    const subToolNames = (await store.load(subThreadId)).filter(e => e.kind === 'tool.call').map(e => (e.payload as any).name);
    assert.deepEqual(subToolNames, ['list_files', 'read_file']);
  } finally { await cleanup(); }
});

test('委派:父上下文体积明显小于把过程摊开', async () => {
  const { ws, cleanup } = await fixture();
  try {
    const store = new MemoryStore();
    const provider = new RoleProvider('数一下有几个文件');
    const threadId = 'thr_size'; const turnId = newTurnId();
    await seed(store, threadId, turnId, '帮我数文件');
    await runTurn({ store, provider, toolset: 'coding', workspace: ws, maxSteps: 6 }, threadId, turnId);

    const parentMsgs = fold(await store.load(threadId), turnId).msgs;
    const subMsgs = fold(await store.load(`${threadId}~sub_p1`), 'trn_p1').msgs;
    // 子 agent 消息更多(它干了活),父 agent 只多一条 tool 结果
    assert.ok(subMsgs.length > parentMsgs.length - 1,
      `父 ${parentMsgs.length} 条 / 子 ${subMsgs.length} 条:委派没起到隔离作用`);
  } finally { await cleanup(); }
});

test('委派:深度上限之外 delegate 不再上架', () => {
  assert.equal(depthOf('thr_a'), 0);
  assert.equal(depthOf('thr_a~sub_x'), 1);
  assert.equal(depthOf('thr_a~sub_x~sub_y'), 2);

  const names = (opts: { spawn: boolean }) => toolSpecs('coding', opts).map(t => t.name);
  assert.ok(names({ spawn: true }).includes('delegate'));
  assert.ok(!names({ spawn: false }).includes('delegate'), '拿不到 spawn 时不该把 delegate 摆出来');
});

test('委派:同一 turn 重投不会把子任务重跑一遍(确定性子 ID)', async () => {
  const { ws, cleanup } = await fixture();
  try {
    const store = new MemoryStore();
    const provider = new RoleProvider('数一下有几个文件');
    const threadId = 'thr_replay'; const turnId = newTurnId();
    await seed(store, threadId, turnId, '帮我数文件');
    await runTurn({ store, provider, toolset: 'coding', workspace: ws, maxSteps: 6 }, threadId, turnId);
    const childAfterFirst = provider.childCalls;

    // 重投同一个 turn:delegate 的 tool.result 已在日志里,decide 不会再派一次
    await runTurn({ store, provider, toolset: 'coding', workspace: ws, maxSteps: 6 }, threadId, turnId);
    assert.equal(provider.childCalls, childAfterFirst, '重投把子 agent 又跑了一遍');

    const delegates = (await store.load(threadId)).filter(e => e.kind === 'tool.call').length;
    assert.equal(delegates, 1);
  } finally { await cleanup(); }
});
