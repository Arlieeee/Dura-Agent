/** 前缀缓存的前提:请求只追加、不改写。每个请求的消息列表都是上一个请求的延伸,system 纯静态。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMsg, ChatResult } from '../../../packages/protocol/src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';
import { MemoryStore, eventId } from '../src/store.js';
import { runTurn, newTurnId } from '../src/engine/runner.js';
import { openWorkspace } from '../src/workspace.js';

const usage = { prompt_tokens: 10, completion_tokens: 5 };

/** 每个 turn:写一个文件 → 读回来 → 收尾。记录每次请求的完整消息列表。 */
function recorder(requests: ChatMsg[][]): ChatProvider {
  let n = 0;
  return {
    name: 'recorder', summarize: async () => '',
    async chat(msgs: ChatMsg[]): Promise<ChatResult> {
      requests.push(structuredClone(msgs));
      const k = n++ % 3;
      if (k === 0) return { text: '', usage, tool_calls: [{ id: `w${n}`, name: 'write_file', args: { path: `f${n}.txt`, content: 'x' } }] };
      if (k === 1) return { text: '', usage, tool_calls: [{ id: `r${n}`, name: 'read_file', args: { path: `f${n - 1}.txt` } }] };
      return { text: '好了', tool_calls: [], usage };
    },
  };
}

async function turn(store: MemoryStore, threadId: string, text: string, provider: ChatProvider, ws: Awaited<ReturnType<typeof openWorkspace>>) {
  const turnId = newTurnId();
  await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
  await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text } });
  await runTurn({ store, provider, toolset: 'coding', workspace: ws, memoryDir: null }, threadId, turnId);
}

test('请求只追加:同一 turn 内、跨 turn 都是上一次请求的延伸;system 纯静态,清单在对话里', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prompt-'));
  try {
    const ws = await openWorkspace(dir);
    await ws.write('a.txt', 'alpha');
    const requests: ChatMsg[][] = [];
    const provider = recorder(requests);
    const store = new MemoryStore();
    await store.createThread('thr_p', 't', 'u');
    await turn(store, 'thr_p', '写个文件', provider, ws);
    await turn(store, 'thr_p', '再写一个', provider, ws);

    assert.equal(requests.length, 6);
    assert.equal(new Set(requests.map(r => r[0].content)).size, 1, 'system prompt 必须逐字节相同');
    assert.doesNotMatch(requests[0][0].content, /a\.txt/, '工作区清单不许进 system prompt');
    assert.ok(requests[0].some(m => m.role === 'user' && /a\.txt/.test(m.content)), '清单作为 user 消息出现');
    for (let k = 1; k < requests.length; k++) {
      assert.deepEqual(requests[k].slice(0, requests[k - 1].length), requests[k - 1], `第 ${k} 次请求改写了前缀`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
