/** 前缀缓存的前提:同一 turn 内每一步的 system prompt 逐字节相同。 */
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

test('多步 turn 里 system prompt 不变,且每步都带工作区清单', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prompt-'));
  try {
    const ws = await openWorkspace(dir);
    await ws.write('a.txt', 'alpha');
    const systems: string[] = [];
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    const provider: ChatProvider = {
      name: 'recorder', summarize: async () => '',
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        systems.push(msgs[0].content);
        const n = systems.length;
        if (n === 1) return { text: '', usage, tool_calls: [{ id: 'w1', name: 'write_file', args: { path: 'b.txt', content: 'beta' } }] };
        if (n === 2) return { text: '', usage, tool_calls: [{ id: 'r1', name: 'read_file', args: { path: 'b.txt' } }] };
        return { text: '好了', tool_calls: [], usage };
      },
    };
    const store = new MemoryStore();
    const threadId = 'thr_p'; const turnId = newTurnId();
    await store.createThread(threadId, 't', 'u');
    await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
    await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text: '写个文件' } });
    await runTurn({ store, provider, toolset: 'coding', workspace: ws, memoryDir: null }, threadId, turnId);

    assert.equal(systems.length, 3);
    assert.equal(new Set(systems).size, 1, '各步 system prompt 必须逐字节相同');
    assert.match(systems[0], /a\.txt/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
