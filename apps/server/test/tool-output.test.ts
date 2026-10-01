/** 大工具结果:溢出到文件,上下文只留头尾预览 + 路径,而不是悄悄截掉后半截。 */
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
import { inlineToolOutput, formatToolOutput, needsSpill, INLINE_LIMIT } from '../src/engine/tool-output.js';

const BIG = { exit_code: 1, stdout: Array.from({ length: 400 }, (_, i) => `PASS check_${i}`).join('\n') + '\nFAIL check_vat: expected 12.35, got 12.34', stderr: '' };

test('小结果原样 JSON;大结果溢出后给头尾 + 提示,结论在尾部也看得见', () => {
  assert.equal(needsSpill({ ok: 1 }), false);
  assert.equal(inlineToolOutput({ ok: 1 }), '{"ok":1}');
  assert.equal(needsSpill(BIG), true);

  const legacy = inlineToolOutput(BIG);
  assert.doesNotMatch(legacy, /FAIL check_vat/, '旧渲染:尾部被悄悄截掉');

  const shown = inlineToolOutput(BIG, '.dura/spill/c1.txt');
  assert.ok(shown.length < INLINE_LIMIT + 300);
  assert.match(shown, /^\[exit_code\] 1/);
  assert.match(shown, /FAIL check_vat: expected 12\.35, got 12\.34/);
  assert.match(shown, /中间省略 \d+ 字符。完整结果在 \.dura\/spill\/c1\.txt/);
  assert.equal(shown, inlineToolOutput(BIG, '.dura/spill/c1.txt'), '同一事件必须渲染成同一段文本');
});

test('formatToolOutput:多行字符串原样展开,数组一项一行', () => {
  assert.equal(formatToolOutput({ a: 'x\ny', n: 2, m: [{ l: 1 }, { l: 2 }] }), '[a]\nx\ny\n[n] 2\n[m]\n{"l":1}\n{"l":2}');
});

test('runner:大结果全文写进 .dura/spill,事件记路径;清单里不出现 .dura,但能直接列', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spill-'));
  try {
    const ws = await openWorkspace(dir);
    await ws.write('server.log', Array.from({ length: 600 }, (_, i) => `2026-09-30 INFO request ${i} ok`).join('\n') + '\nERROR request 599 timeout');
    const seen: ChatMsg[][] = [];
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    const provider: ChatProvider = {
      name: 'reader', summarize: async () => '',
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        seen.push(msgs);
        if (seen.length === 1) return { text: '', usage, tool_calls: [{ id: 'r1', name: 'read_file', args: { path: 'server.log' } }] };
        return { text: '最后一行是超时', tool_calls: [], usage };
      },
    };
    const store = new MemoryStore();
    const turnId = newTurnId();
    await store.createThread('thr_s', 't', 'u');
    await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: 'thr_s', turn_id: turnId, kind: 'turn.started', payload: {} });
    await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: 'thr_s', turn_id: turnId, kind: 'user.message', payload: { text: '看日志' } });
    await runTurn({ store, provider, toolset: 'coding', workspace: ws, memoryDir: null }, 'thr_s', turnId);

    const result = (await store.load('thr_s')).find(e => e.kind === 'tool.result')!;
    assert.equal(result.payload.spilled_to, '.dura/spill/r1.txt');
    assert.match(await ws.read('.dura/spill/r1.txt'), /ERROR request 599 timeout/);
    const toolMsg = seen[1].find(m => m.role === 'tool')!;
    assert.match(toolMsg.content, /ERROR request 599 timeout/, '尾部进了上下文');
    assert.match(toolMsg.content, /\.dura\/spill\/r1\.txt/);

    assert.ok(!(await ws.list()).some(f => f.startsWith('.dura')), '.dura 不进工作区清单');
    assert.deepEqual(await ws.list('.dura/spill'), ['.dura/spill/r1.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
