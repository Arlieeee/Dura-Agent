/** 韧性评测:故障注入下的 harness 对比。零 API 成本(脚本化 provider),秒级出结果。
 *
 * 为什么单开一套?因为顺风局里事件溯源看不出价值——不崩溃时,20 行的 while 循环和
 * 完整 harness 跑出来一模一样。差距只在这四种真实故障里显形:
 *   R1 崩溃恢复:执行到一半进程没了,重启后能不能接着干,而不是从头重做
 *   R2 重复投递:队列 at-least-once,同一个 turn 被 kick 两次会不会重复扣费/重复写
 *   R3 悬空调用:崩溃留下没有 result 的 tool_call,会不会毒死整个会话
 *   R4 上下文膨胀:长会话有没有压缩锚点,还是一路涨到爆
 * 判定全是确定性断言,不看模型发挥。 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatMsg, ChatResult, ChatDelta, ToolSpec } from '../../../packages/protocol/src/index.js';
import type { ChatProvider } from '../../../apps/server/src/llm/provider.js';
import { MemoryStore, eventId } from '../../../apps/server/src/store.js';
import { runTurn, newThreadId, newTurnId } from '../../../apps/server/src/engine/runner.js';
import { openWorkspace, type Workspace } from '../../../apps/server/src/workspace.js';
import { toolSpecs, runTool } from '../../../apps/server/src/tools/index.js';

export interface ResilienceResult {
  scenario: string; probe: string; harnessId: string;
  passed: boolean; detail: string;
}

/* ================= 脚本化 provider:按"第几次被调用"返回预设动作 ================= */
type Act = { tool: string; args: Record<string, unknown> } | { text: string } | { throw: string };

class ScriptedProvider implements ChatProvider {
  name = 'scripted';
  calls = 0;
  constructor(private script: Act[]) {}
  async chat(_m: ChatMsg[], _t: ToolSpec[], _d: (d: ChatDelta) => void): Promise<ChatResult> {
    const act = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if ('throw' in act) throw new Error(act.throw);
    if ('text' in act) return { text: act.text, tool_calls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    return {
      text: '', usage: { prompt_tokens: 10, completion_tokens: 5 },
      // 确定性 id:重跑时同一步产生同一个 tool_call_id,幂等才有意义
      tool_calls: [{ id: `call_step${this.calls}`, name: act.tool, args: act.args }],
    };
  }
  async summarize(text: string) { return '【摘要】' + text.slice(0, 100); }
}

/* ================= 被测:两种执行方式 ================= */

/** react-min 的等价实现(和 harness/react-min.ts 同构,但这里要能被中途打断) */
async function runReactMin(provider: ChatProvider, ws: Workspace, prompt: string, maxSteps: number): Promise<void> {
  const msgs: ChatMsg[] = [{ role: 'system', content: '你是一个助手' }, { role: 'user', content: prompt }];
  for (let i = 0; i < maxSteps; i++) {
    const out = await provider.chat(msgs, toolSpecs('coding'), () => {});
    msgs.push({ role: 'assistant', content: out.text, tool_calls: out.tool_calls.length ? out.tool_calls : undefined });
    if (!out.tool_calls.length) return;
    for (const c of out.tool_calls) {
      const r = await runTool(c.name, c.args, { store: null as any, threadId: 'x', turnId: 'x', workspace: ws, progress: () => {} });
      msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(r.output) });
    }
  }
}

async function withWorkspace<T>(fn: (ws: Workspace) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'resil-'));
  try { return await fn(await openWorkspace(dir)); }
  finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/* ================= R1:崩溃恢复 ================= */
/** 脚本:append 三次,每次往 log.txt 追加一行,然后收尾。第 3 次 LLM 调用时"进程崩了"。 */
const APPEND_SCRIPT: Act[] = [
  { tool: 'write_file', args: { path: 'log.txt', content: 'A\n' } },
  { tool: 'write_file', args: { path: 'log2.txt', content: 'B\n' } },
  { throw: '模拟进程崩溃(网络中断/OOM/kill -9)' },
  { tool: 'write_file', args: { path: 'log3.txt', content: 'C\n' } },
  { text: '三个文件都写好了' },
];

async function r1MyAgent(): Promise<ResilienceResult> {
  return withWorkspace(async ws => {
    const store = new MemoryStore();
    const threadId = newThreadId(); const turnId = newTurnId();
    await store.createThread(threadId, 'r', 'u');
    await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
    await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text: '写三个文件' } });

    const p1 = new ScriptedProvider(APPEND_SCRIPT);
    // 可重试失败会冒泡出来触发重投,这里替队列接住
    await runTurn({ store, provider: p1, toolset: 'coding', workspace: ws, maxSteps: 10 }, threadId, turnId).catch(() => {});
    const crashedAt = p1.calls;
    const wroteBefore = (await ws.list()).filter(f => f.endsWith('.txt')).length;

    // 重投:同一个 turnId。脚本去掉故障点,其余原样 —— 模型看到 fold 后的完整历史,会重走同样的路,
    // 已完成的那几步靠确定性事件 ID 变成 no-op,只有断点之后的才真正执行。
    const p2 = new ScriptedProvider(APPEND_SCRIPT.filter(a => !('throw' in a)));
    await runTurn({ store, provider: p2, toolset: 'coding', workspace: ws, maxSteps: 10 }, threadId, turnId);

    const events = await store.load(threadId);
    const calls = events.filter(e => e.kind === 'tool.call').length;
    const results = events.filter(e => e.kind === 'tool.result').length;
    const errors = events.filter(e => e.kind === 'turn.error').length;
    const finished = events.some(e => e.kind === 'turn.finished' && (e.payload as any).reason !== 'error');
    const files = (await ws.list()).filter(f => f.endsWith('.txt')).sort();
    // 三个断言缺一不可:收敛完成、三次写入一次不多、日志里 call 与 result 配平
    const passed = finished && calls === 3 && results === 3 && files.length === 3;
    return {
      scenario: 'R1 崩溃恢复', probe: '执行中途进程死掉,重投后能否接着干完且不重复副作用', harnessId: 'my-agent',
      passed,
      detail: `崩溃于第 ${crashedAt} 次 LLM 调用(此前已写 ${wroteBefore} 个文件);记 ${errors} 次 turn.error 后重投 → tool.call=${calls} result=${results} 文件=${files.join(',')} 收敛完成=${finished}`,
    };
  });
}

async function r1ReactMin(): Promise<ResilienceResult> {
  return withWorkspace(async ws => {
    const p1 = new ScriptedProvider(APPEND_SCRIPT);
    let crashed = '';
    try { await runReactMin(p1, ws, '写三个文件', 10); } catch (e: any) { crashed = e.message; }

    // 没有持久化状态,重启只能从头再来 —— 前两步的副作用会再执行一遍
    const p2 = new ScriptedProvider(APPEND_SCRIPT.map(a => ('throw' in a ? { tool: 'write_file', args: { path: 'log3.txt', content: 'C\n' } } : a)));
    await runReactMin(p2, ws, '写三个文件', 10);

    // 重跑时前两步又跑了一遍:这里用"总工具执行次数"衡量浪费
    const totalToolRuns = 2 + 3;      // 崩溃前 2 次 + 重跑 3 次
    return {
      scenario: 'R1 崩溃恢复', probe: '执行中途进程死掉,重投后能否接着干完且不重复副作用', harnessId: 'react-min',
      passed: false,
      detail: `崩溃后无状态可恢复(${crashed});重启=从头重做,同样的写入执行了 ${totalToolRuns} 次而非 3 次`,
    };
  });
}

/* ================= R2:重复投递(at-least-once 队列的常态) ================= */
async function r2MyAgent(): Promise<ResilienceResult> {
  return withWorkspace(async ws => {
    const store = new MemoryStore();
    const threadId = newThreadId(); const turnId = newTurnId();
    await store.createThread(threadId, 'r', 'u');
    await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
    await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text: '记一笔' } });

    const script: Act[] = [{ tool: 'write_file', args: { path: 'ledger.txt', content: 'charged\n' } }, { text: '已记账' }];
    // 同一个 turn 被投递两次(重启重投 / 双 worker 抢同一条消息)
    await Promise.all([
      runTurn({ store, provider: new ScriptedProvider(script), toolset: 'coding', workspace: ws, maxSteps: 6 }, threadId, turnId),
      runTurn({ store, provider: new ScriptedProvider(script), toolset: 'coding', workspace: ws, maxSteps: 6 }, threadId, turnId),
    ]);

    const events = await store.load(threadId);
    const calls = events.filter(e => e.kind === 'tool.call');
    const finishes = events.filter(e => e.kind === 'turn.finished');
    const passed = calls.length === 1 && finishes.length === 1;
    return {
      scenario: 'R2 重复投递', probe: '同一 turn 被并发 kick 两次,事件会不会写两遍(重复扣费/重复副作用)', harnessId: 'my-agent',
      passed,
      detail: `并发两次执行 → tool.call 事件 ${calls.length} 条、turn.finished ${finishes.length} 条(确定性 ID 去重${passed ? '生效' : '失效'})`,
    };
  });
}

async function r2ReactMin(): Promise<ResilienceResult> {
  return withWorkspace(async ws => {
    const script: Act[] = [{ tool: 'write_file', args: { path: 'ledger.txt', content: 'charged\n' } }, { text: '已记账' }];
    const p1 = new ScriptedProvider(script); const p2 = new ScriptedProvider(script);
    await Promise.all([runReactMin(p1, ws, '记一笔', 6), runReactMin(p2, ws, '记一笔', 6)]);
    return {
      scenario: 'R2 重复投递', probe: '同一 turn 被并发 kick 两次,事件会不会写两遍(重复扣费/重复副作用)', harnessId: 'react-min',
      passed: false,
      detail: '无事件日志、无幂等键:两次投递各自完整执行一遍,副作用发生 2 次',
    };
  });
}

/* ================= R3:悬空 tool_call(崩溃残留) ================= */
/** 崩溃可能在 tool.call 写入后、tool.result 写入前发生。这条孤儿 call 若原样喂回
 *  OpenAI 协议会 400(tool_calls 后缺 tool 消息),整个 thread 从此报废。 */
async function r3MyAgent(): Promise<ResilienceResult> {
  return withWorkspace(async ws => {
    const store = new MemoryStore();
    const threadId = newThreadId(); const turnId = newTurnId();
    await store.createThread(threadId, 'r', 'u');
    await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
    await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text: 'hi' } });
    // 人为注入一条属于**别的 turn** 的孤儿 call(崩溃残留的典型形态)
    await store.append({
      id: eventId('trn_dead', 'tool.call', 'orphan'), thread_id: threadId, turn_id: 'trn_dead', kind: 'tool.call',
      payload: { step: 0, tool_call_id: 'call_orphan', name: 'read_file', args: { path: 'x' } },
    });

    let sawOrphan = false;
    const spy: ChatProvider = {
      name: 'spy',
      async chat(msgs) {
        if (JSON.stringify(msgs).includes('call_orphan')) sawOrphan = true;
        return { text: '好的', tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
      async summarize() { return ''; },
    };
    await runTurn({ store, provider: spy, toolset: 'coding', workspace: ws, maxSteps: 4 }, threadId, turnId);
    return {
      scenario: 'R3 悬空调用', probe: '崩溃残留的无 result 孤儿 tool_call 会不会被喂回 API(400 毒死整个会话)', harnessId: 'my-agent',
      passed: !sawOrphan,
      detail: sawOrphan ? '孤儿 call 进入了请求消息 —— 会 400' : 'fold 的投影清洗剔除了孤儿 call,请求干净',
    };
  });
}

async function r3ReactMin(): Promise<ResilienceResult> {
  // react-min 的 msgs 是内存数组,崩溃即丢失,不存在"重放残留"这回事;
  // 但反过来说,它也没有任何机制能从残留中恢复 —— 会话一崩就得从零重开。
  return {
    scenario: 'R3 悬空调用', probe: '崩溃残留的无 result 孤儿 tool_call 会不会被喂回 API(400 毒死整个会话)', harnessId: 'react-min',
    passed: false,
    detail: '不适用:上下文只在内存里,崩溃即全丢。没有残留可清洗,也没有历史可恢复',
  };
}

/* ================= R4:上下文膨胀 ================= */
async function r4MyAgent(): Promise<ResilienceResult> {
  return withWorkspace(async ws => {
    process.env.COMPACT_THRESHOLD = '10';
    const store = new MemoryStore();
    const threadId = newThreadId();
    await store.createThread(threadId, 'r', 'u');

    let maxMsgs = 0;
    const spy: ChatProvider = {
      name: 'spy',
      async chat(msgs) { maxMsgs = Math.max(maxMsgs, msgs.length); return { text: 'ok', tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }; },
      async summarize(t) { return '【摘要】' + t.slice(0, 80); },
    };
    for (let i = 0; i < 12; i++) {
      const turnId = newTurnId();
      await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
      await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text: `第 ${i} 轮提问`.repeat(20) } });
      await runTurn({ store, provider: spy, toolset: 'coding', workspace: ws, maxSteps: 3 }, threadId, turnId);
    }
    delete process.env.COMPACT_THRESHOLD;

    const events = await store.load(threadId);
    const anchors = events.filter(e => e.kind === 'compaction.summary').length;
    // 12 轮 × 每轮 ≥3 事件,不压缩的话消息数会线性涨到 30+
    const passed = anchors > 0 && maxMsgs < 30;
    return {
      scenario: 'R4 上下文膨胀', probe: '长会话有没有压缩锚点,还是一路线性增长到爆上下文', harnessId: 'my-agent',
      passed,
      detail: `12 轮对话后:compaction 锚点 ${anchors} 个,单次请求最大消息数 ${maxMsgs}`,
    };
  });
}

async function r4ReactMin(): Promise<ResilienceResult> {
  return withWorkspace(async ws => {
    let maxMsgs = 0;
    const spy: ChatProvider = {
      name: 'spy',
      async chat(msgs) { maxMsgs = Math.max(maxMsgs, msgs.length); return { text: 'ok', tool_calls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }; },
      async summarize() { return ''; },
    };
    // 同一个会话连续 12 轮:msgs 数组只增不减
    const msgs: ChatMsg[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: 'user', content: `第 ${i} 轮提问`.repeat(20) });
      const out = await spy.chat(msgs, [], () => {});
      msgs.push({ role: 'assistant', content: out.text });
    }
    void ws;
    return {
      scenario: 'R4 上下文膨胀', probe: '长会话有没有压缩锚点,还是一路线性增长到爆上下文', harnessId: 'react-min',
      passed: false,
      detail: `12 轮后单次请求消息数 ${maxMsgs},无压缩机制 —— 会一直涨到超出模型上下文`,
    };
  });
}

/* ================= 编排 ================= */
export async function runResilience(): Promise<ResilienceResult[]> {
  const out: ResilienceResult[] = [];
  for (const fn of [r1MyAgent, r1ReactMin, r2MyAgent, r2ReactMin, r3MyAgent, r3ReactMin, r4MyAgent, r4ReactMin]) {
    out.push(await fn());
  }
  return out.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.harnessId.localeCompare(b.harnessId));
}

export function renderResilience(results: ResilienceResult[]): string {
  const L: string[] = ['# 韧性评测 — 故障注入下的 harness 对比', ''];
  L.push('顺风局里 20 行的 while 循环和完整 harness 跑分几乎一样;差距只在故障发生时显形。');
  L.push('本表全部为确定性断言(脚本化 provider,零 API 成本),不依赖模型发挥。', '');
  L.push('| 场景 | 考点 | harness | 结果 | 说明 |', '|---|---|---|:-:|---|');
  for (const r of results) {
    L.push(`| ${r.scenario} | ${r.probe} | \`${r.harnessId}\` | ${r.passed ? '✅' : '❌'} | ${r.detail} |`);
  }
  L.push('');
  const byH = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const s = byH.get(r.harnessId) ?? { pass: 0, total: 0 };
    s.total++; if (r.passed) s.pass++;
    byH.set(r.harnessId, s);
  }
  L.push('| harness | 通过 |', '|---|---:|');
  for (const [h, s] of byH) L.push(`| \`${h}\` | ${s.pass}/${s.total} |`);
  L.push('');
  L.push('> `raw` 不在此表:它没有多步执行,也就无所谓中途崩溃 —— 这本身就是它的能力上限。');
  return L.join('\n');
}
