/** decide 纯函数单测:全分支覆盖,无需任何 mock 基础设施。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/engine/decide.js';
import type { TurnState } from '../src/engine/fold.js';

const base = (over: Partial<TurnState> = {}): TurnState => ({
  threadId: 'thr_t', turnId: 'trn_t', status: 'running',
  msgs: [], pendingCalls: [], step: 0, eventCount: 0, attempts: 0, seenCallIds: new Set(), ...over,
});

test('无消息 → idle stop', () => {
  assert.deepEqual(decide(base()), { type: 'idle', reason: 'stop' });
});

test('最后一条是 user → call_llm', () => {
  const cmd = decide(base({ msgs: [{ role: 'user', content: '你好' }] }));
  assert.equal(cmd.type, 'call_llm');
});

test('最后一条是 tool 结果 → call_llm(继续想)', () => {
  const cmd = decide(base({ msgs: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'web_search', args: {} }] },
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
  ] }));
  assert.equal(cmd.type, 'call_llm');
});

test('pending server tool → execute_tools(单个)', () => {
  const call = { id: 'c1', name: 'web_search', args: { query: 'x' } };
  const cmd = decide(base({ pendingCalls: [call], msgs: [{ role: 'assistant', content: '', tool_calls: [call] }] }));
  assert.deepEqual(cmd, { type: 'execute_tools', calls: [call] });
});

test('一批只读工具 → 整批并发', () => {
  const calls = [
    { id: 'c1', name: 'read_file', args: { path: 'a' } },
    { id: 'c2', name: 'read_file', args: { path: 'b' } },
    { id: 'c3', name: 'grep_files', args: { pattern: 'x' } },
  ];
  assert.deepEqual(decide(base({ pendingCalls: calls })), { type: 'execute_tools', calls });
});

test('批里混入写工具 → 退回串行,一次只跑第一个', () => {
  const calls = [
    { id: 'c1', name: 'read_file', args: { path: 'a' } },
    { id: 'c2', name: 'write_file', args: { path: 'b', content: 'x' } },
  ];
  // write 有副作用(先 mkdir 再写这类隐含依赖),整批不能并发
  assert.deepEqual(decide(base({ pendingCalls: calls })), { type: 'execute_tools', calls: [calls[0]] });
});

test('并发批在遇到 client tool 处截断', () => {
  const calls = [
    { id: 'c1', name: 'read_file', args: { path: 'a' } },
    { id: 'c2', name: 'list_files', args: {} },
    { id: 'c3', name: 'ask_user', args: { question: '?' } },
  ];
  assert.deepEqual(decide(base({ pendingCalls: calls })), { type: 'execute_tools', calls: [calls[0], calls[1]] });
});

test('client tool 排在最前 → 先挂起,不碰后面的', () => {
  const calls = [
    { id: 'c1', name: 'ask_user', args: { question: '?' } },
    { id: 'c2', name: 'read_file', args: { path: 'a' } },
  ];
  assert.deepEqual(decide(base({ pendingCalls: calls })), { type: 'suspend', call: calls[0] });
});

test('pending client tool(ask_user)→ suspend', () => {
  const call = { id: 'c2', name: 'ask_user', args: { question: '?' } };
  const cmd = decide(base({ pendingCalls: [call] }));
  assert.deepEqual(cmd, { type: 'suspend', call });
});

test('挂起中 → noop(等 user.confirmation)', () => {
  const cmd = decide(base({ suspended: { tool_call_id: 'c2', name: 'ask_user', question: '?' } }));
  assert.deepEqual(cmd, { type: 'noop' });
});

test('已结束 → noop', () => {
  assert.deepEqual(decide(base({ status: 'finished' })), { type: 'noop' });
});

test('step 达到上限 → idle max-steps', () => {
  const cmd = decide(base({ step: 12, msgs: [{ role: 'user', content: 'q' }] }));
  assert.deepEqual(cmd, { type: 'idle', reason: 'max-steps' });
});

test('assistant 纯文本收尾 → idle stop', () => {
  const cmd = decide(base({ msgs: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '答' }] }));
  assert.deepEqual(cmd, { type: 'idle', reason: 'stop' });
});
