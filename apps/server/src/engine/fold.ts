/** fold(events) → state:纯函数,无 I/O。状态是折叠,不是存储。 */
import type { AgentEvent, ChatMsg, ToolCallReq } from '../../../../packages/protocol/src/index.js';

export interface TurnState {
  threadId: string;
  turnId: string;
  status: 'idle' | 'running' | 'suspended' | 'finished';
  msgs: ChatMsg[];
  pendingCalls: ToolCallReq[];
  suspended?: { tool_call_id: string; name: string; question: string; options?: string[] };
  step: number;
  eventCount: number;
  /** 本 turn 已发生过几次可重试失败。用来给重投设上限,避免坏消息无限打转。 */
  attempts: number;
  /** 已有结果的 tool_call_id。runner 靠它识别"这一步只是重放",不必再留痕。 */
  seenCallIds: Set<string>;
  /** 日志里有本 turn 的 user.interrupt。 */
  interrupted: boolean;
  /** 已开工(tool.started)的 tool_call_id。开工了却还在 pendingCalls 里 = 执行中途崩溃。 */
  startedCallIds: Set<string>;
  /** 锚点之后最近一次环境快照的正文。runner 据此判断要不要追加新快照(内容没变就不追加)。 */
  lastContext?: string;
}

export function fold(events: AgentEvent[], turnId: string): TurnState {
  let anchor = -1; let summary: string | undefined;
  events.forEach((e, i) => { if (e.kind === 'compaction.summary') { anchor = i; summary = String(e.payload.summary ?? ''); } });

  const st: TurnState = { threadId: events[0]?.thread_id ?? '', turnId, status: 'idle', msgs: [], pendingCalls: [], step: 0, eventCount: 0, attempts: 0, seenCallIds: new Set(), interrupted: false, startedCallIds: new Set() };
  // 摘要是对话里的一条消息,不进 system prompt:压缩前后 system + 工具定义这段前缀不变,缓存照常命中
  if (summary) st.msgs.push({ role: 'user', content: `【此前对话摘要】${summary}` });
  // 快照在日志里排在本 turn 的 user.message 之后(runner 开工时才追加),渲染时放到它前面:
  // 最后一条 user 消息始终是用户原话。第一次请求在快照落盘之后才发出,所以两种顺序都只追加、不改写
  const snapshots = new Map<string, string>();
  for (let i = anchor + 1; i < events.length; i++) {
    if (events[i].kind === 'context.snapshot') snapshots.set(events[i].turn_id, String(events[i].payload.text ?? ''));
  }
  const resultSeen = new Set<string>();

  for (let i = anchor + 1; i < events.length; i++) {
    const e = events[i]; const p = e.payload as any;
    st.eventCount++;
    switch (e.kind) {
      case 'turn.started':
        if (e.turn_id === turnId) { st.status = 'running'; st.step = 0; st.pendingCalls = []; st.suspended = undefined; }
        break;
      case 'user.message': {
        const context = snapshots.get(e.turn_id);
        if (context !== undefined) { st.msgs.push({ role: 'user', content: context }); st.lastContext = context; }
        st.msgs.push({ role: 'user', content: String(p.text ?? '') });
        break;
      }
      case 'assistant.message': {
        // DeepSeek 思考模式契约:工具调用轮次的 reasoning_content 必须回传(无工具时 API 会忽略,恒传安全)
        st.msgs.push({ role: 'assistant', content: String(p.text ?? ''), reasoning_content: p.reasoning ? String(p.reasoning) : undefined, tool_calls: undefined });
        if (e.turn_id === turnId) st.step = Math.max(st.step, Number(p.step ?? 0) + 1);
        break;
      }
      case 'tool.call': {
        const call: ToolCallReq = { id: String(p.tool_call_id), name: String(p.name), args: (p.args ?? {}) as any };
        const last = st.msgs[st.msgs.length - 1];
        if (last?.role === 'assistant') (last.tool_calls ??= []).push(call);
        else st.msgs.push({ role: 'assistant', content: '', tool_calls: [call] });
        if (e.turn_id === turnId && !resultSeen.has(call.id)) st.pendingCalls.push(call);
        break;
      }
      case 'tool.result': {
        const id = String(p.tool_call_id);
        resultSeen.add(id);
        st.pendingCalls = st.pendingCalls.filter(c => c.id !== id);
        if (st.suspended?.tool_call_id === id) st.suspended = undefined;
        st.msgs.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(p.output ?? null).slice(0, 4000) });
        break;
      }
      case 'turn.suspended':
        if (e.turn_id === turnId) {
          st.status = 'suspended';
          st.suspended = { tool_call_id: String(p.tool_call_id), name: String(p.name), question: String(p.question ?? ''), options: p.options };
        }
        break;
      case 'user.confirmation': {
        const id = String(p.tool_call_id);
        resultSeen.add(id);
        st.pendingCalls = st.pendingCalls.filter(c => c.id !== id);
        if (st.suspended?.tool_call_id === id) { st.suspended = undefined; st.status = 'running'; }
        st.msgs.push({ role: 'tool', tool_call_id: id, content: JSON.stringify({ answer: p.answer }) });
        break;
      }
      case 'turn.error':
        // 只计数、不改 status:turn 仍是 running,重投后 decide 会从断点继续
        if (e.turn_id === turnId) st.attempts++;
        break;
      case 'tool.started':
        st.startedCallIds.add(String(p.tool_call_id));
        break;
      case 'user.interrupt':
        if (e.turn_id === turnId) st.interrupted = true;
        break;
      case 'turn.finished':
        if (e.turn_id === turnId) st.status = 'finished';
        break;
    }
  }
  // 投影清洗:剔除悬空 tool_calls(并发重跑/崩溃可能留下无 result 的孤儿 call;
  // 喂给 OpenAI 协议会因「tool_calls 后缺 tool 消息」400,毒害整个 thread)
  const pendingIds = new Set(st.pendingCalls.map(c => c.id));
  st.msgs = st.msgs.filter(m => {
    if (m.role !== 'assistant') return true;
    if (m.tool_calls) {
      m.tool_calls = m.tool_calls.filter(c => resultSeen.has(c.id) || pendingIds.has(c.id) || st.suspended?.tool_call_id === c.id);
      if (!m.tool_calls.length) m.tool_calls = undefined;
    }
    // 三者皆空的 assistant 一律剔除。重投时模型会重新产出已存在的 tool_call,append 幂等 no-op,
    // 于是日志里留下"光杆 assistant";若放行,decide 会把它当成纯文本收尾而误判 turn 已完成。
    return !!(m.content || m.reasoning_content || m.tool_calls);
  });
  st.seenCallIds = resultSeen;
  return st;
}

/** thread 上还没收尾的 turn(pending / running / suspended 都算)。准入门禁与冷加载共用。 */
export function activeTurnId(events: AgentEvent[]): string | undefined {
  const finished = new Set(events.filter(e => e.kind === 'turn.finished').map(e => e.turn_id));
  return [...events].reverse().find(e => e.kind === 'turn.started' && !finished.has(e.turn_id))?.turn_id;
}
