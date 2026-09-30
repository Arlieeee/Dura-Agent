/** fold 纯函数单测:事件回放 → 状态折叠。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, activeTurnId } from '../src/engine/fold.js';
import { eventId } from '../src/store.js';
import type { AgentEvent } from '../../../packages/protocol/src/index.js';

let seq = 0;
const ev = (kind: AgentEvent['kind'], payload: Record<string, unknown>, turn = 'trn_1'): AgentEvent =>
  ({ id: 'ev_' + ++seq, thread_id: 'thr_1', turn_id: turn, kind, payload, seq });

test('基本回放:started + user.message → running,msgs 有 user', () => {
  const st = fold([ev('turn.started', { text: 'q' }), ev('user.message', { text: 'q' })], 'trn_1');
  assert.equal(st.status, 'running');
  assert.deepEqual(st.msgs, [{ role: 'user', content: 'q' }]);
});

test('tool.call 挂到 assistant 消息并进 pendingCalls;tool.result 清除并追加 tool 消息', () => {
  const events = [
    ev('turn.started', { text: 'q' }),
    ev('user.message', { text: 'q' }),
    ev('assistant.message', { step: 0, text: '' }),
    ev('tool.call', { step: 0, tool_call_id: 'c1', name: 'web_search', args: { query: 'x' } }),
  ];
  let st = fold(events, 'trn_1');
  assert.equal(st.pendingCalls.length, 1);
  assert.equal(st.msgs.at(-1)?.tool_calls?.[0]?.id, 'c1');

  st = fold([...events, ev('tool.result', { tool_call_id: 'c1', name: 'web_search', ok: true, output: { r: 1 } })], 'trn_1');
  assert.equal(st.pendingCalls.length, 0);
  assert.equal(st.msgs.at(-1)?.role, 'tool');
});

test('result 先于 call 回放到(重跑场景):resultSeen 防止重新入队', () => {
  // 收敛式重跑:fold 再次经过 tool.call 时,若其 result 已在日志中,不应再 pending
  const events = [
    ev('turn.started', { text: 'q' }),
    ev('assistant.message', { step: 0, text: '' }),
    ev('tool.call', { step: 0, tool_call_id: 'c1', name: 'web_search', args: {} }),
    ev('tool.result', { tool_call_id: 'c1', name: 'web_search', ok: true, output: {} }),
    ev('assistant.message', { step: 1, text: '' }),
    ev('tool.call', { step: 1, tool_call_id: 'c2', name: 'web_search', args: {} }),
  ];
  const st = fold(events, 'trn_1');
  assert.deepEqual(st.pendingCalls.map(c => c.id), ['c2']);   // c1 已有结果,只有 c2 pending
});

test('挂起/恢复:turn.suspended → suspended;user.confirmation → 解除并回 running', () => {
  const events = [
    ev('turn.started', { text: 'q' }),
    ev('assistant.message', { step: 0, text: '' }),
    ev('tool.call', { step: 0, tool_call_id: 'c1', name: 'ask_user', args: { question: '?' } }),
    ev('turn.suspended', { tool_call_id: 'c1', name: 'ask_user', question: '?' }),
  ];
  let st = fold(events, 'trn_1');
  assert.equal(st.status, 'suspended');
  assert.equal(st.suspended?.tool_call_id, 'c1');

  st = fold([...events, ev('user.confirmation', { tool_call_id: 'c1', answer: 'A' })], 'trn_1');
  assert.equal(st.status, 'running');
  assert.equal(st.suspended, undefined);
  assert.equal(st.pendingCalls.length, 0);
  assert.match(String(st.msgs.at(-1)?.content), /A/);
});

test('compaction 锚点:锚点前事件不进 msgs,摘要成为开头的一条消息', () => {
  const events = [
    ev('user.message', { text: '旧消息' }),
    ev('assistant.message', { step: 0, text: '旧回复' }),
    ev('compaction.summary', { summary: '此前聊了旧话题' }),
    ev('turn.started', { text: '新' }, 'trn_2'),
    ev('user.message', { text: '新消息' }, 'trn_2'),
  ];
  const st = fold(events, 'trn_2');
  assert.deepEqual(st.msgs, [{ role: 'user', content: '【此前对话摘要】此前聊了旧话题' }, { role: 'user', content: '新消息' }]);
});

test('turn 维度隔离:他人 turn 的事件进 msgs 但不改本 turn 的 step/pending', () => {
  const events = [
    ev('turn.started', { text: 'a' }, 'trn_old'),
    ev('user.message', { text: 'a' }, 'trn_old'),
    ev('assistant.message', { step: 0, text: 'ra' }, 'trn_old'),
    ev('turn.finished', { reason: 'stop' }, 'trn_old'),
    ev('turn.started', { text: 'b' }, 'trn_new'),
    ev('user.message', { text: 'b' }, 'trn_new'),
  ];
  const st = fold(events, 'trn_new');
  assert.equal(st.status, 'running');
  assert.equal(st.step, 0);
  assert.equal(st.msgs.length, 3);           // 上下文完整(a、ra、b)
});

test('turn.finished → finished', () => {
  const st = fold([ev('turn.started', { text: 'q' }), ev('turn.finished', { reason: 'stop' })], 'trn_1');
  assert.equal(st.status, 'finished');
});

test('投影清洗:悬空 tool.call(无 result 的孤儿)被剔除,不毒害后续 LLM 调用', () => {
  const events = [
    ev('turn.started', { text: 'q' }, 'trn_old'),
    ev('user.message', { text: 'q' }, 'trn_old'),
    ev('assistant.message', { step: 0, text: '回答完毕' }, 'trn_old'),
    ev('turn.finished', { reason: 'stop' }, 'trn_old'),
    // 并发重跑在 finished 后迟到落下的孤儿 call(无 result)
    ev('assistant.message', { step: 1, text: '' }, 'trn_old'),
    ev('tool.call', { step: 1, tool_call_id: 'call_orphan', name: 'write_document', args: {} }, 'trn_old'),
    ev('turn.started', { text: '新问题' }, 'trn_new'),
    ev('user.message', { text: '新问题' }, 'trn_new'),
  ];
  const st = fold(events, 'trn_new');
  const dangling = st.msgs.filter(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === 'call_orphan'));
  assert.equal(dangling.length, 0);                                    // 孤儿 call 被剔除
  assert.ok(!st.msgs.some(m => m.role === 'assistant' && !m.content && !m.tool_calls && !m.reasoning_content));  // 无全空消息
  assert.equal(st.msgs.at(-1)?.content, '新问题');
});

test('投影清洗:挂起中的 ask_user call 保留(fold 语义不受修剪破坏)', () => {
  const events = [
    ev('turn.started', { text: 'q' }),
    ev('assistant.message', { step: 0, text: '' }),
    ev('tool.call', { step: 0, tool_call_id: 'c1', name: 'ask_user', args: { question: '?' } }),
    ev('turn.suspended', { tool_call_id: 'c1', name: 'ask_user', question: '?' }),
  ];
  const st = fold(events, 'trn_1');
  assert.equal(st.status, 'suspended');
  assert.ok(st.msgs.some(m => m.tool_calls?.some(c => c.id === 'c1')));
});

test('eventId 确定性:同输入同 ID,异输入异 ID(幂等根基)', () => {
  assert.equal(eventId('trn_1', 'tool.result', 'c1'), eventId('trn_1', 'tool.result', 'c1'));
  assert.notEqual(eventId('trn_1', 'tool.result', 'c1'), eventId('trn_1', 'tool.result', 'c2'));
  assert.notEqual(eventId('trn_1', 'tool.result', 'c1'), eventId('trn_2', 'tool.result', 'c1'));
});

test('user.interrupt 只标记本 turn;activeTurnId 找还没收尾的 turn', () => {
  const events = [
    ev('turn.started', {}, 'trn_a'), ev('user.message', { text: 'q' }, 'trn_a'), ev('turn.finished', { reason: 'stop' }, 'trn_a'),
    ev('turn.started', {}, 'trn_b'), ev('user.message', { text: 'q2' }, 'trn_b'), ev('user.interrupt', {}, 'trn_b'),
  ];
  assert.equal(fold(events, 'trn_b').interrupted, true);
  assert.equal(fold(events, 'trn_a').interrupted, false);
  assert.equal(activeTurnId(events), 'trn_b');
  assert.equal(activeTurnId([...events, ev('turn.finished', { reason: 'cancelled' }, 'trn_b')]), undefined);
});

test('环境快照渲染在本 turn 的用户原话之前;lastContext 取最近一条', () => {
  const events = [
    ev('turn.started', {}, 'trn_a'), ev('user.message', { text: '第一问' }, 'trn_a'), ev('context.snapshot', { text: '【工作区】a.txt' }, 'trn_a'),
    ev('assistant.message', { step: 0, text: '答一' }, 'trn_a'), ev('turn.finished', { reason: 'stop' }, 'trn_a'),
    ev('turn.started', {}, 'trn_b'), ev('user.message', { text: '第二问' }, 'trn_b'),
  ];
  const st = fold(events, 'trn_b');
  assert.deepEqual(st.msgs.map(m => m.content), ['【工作区】a.txt', '第一问', '答一', '第二问']);
  assert.equal(st.lastContext, '【工作区】a.txt');
});
