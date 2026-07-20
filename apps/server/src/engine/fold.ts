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
  summary?: string;
  eventCount: number;
}

export function fold(events: AgentEvent[], turnId: string): TurnState {
  let anchor = -1; let summary: string | undefined;
  events.forEach((e, i) => { if (e.kind === 'compaction.summary') { anchor = i; summary = String(e.payload.summary ?? ''); } });

  const st: TurnState = { threadId: events[0]?.thread_id ?? '', turnId, status: 'idle', msgs: [], pendingCalls: [], step: 0, summary, eventCount: 0 };
  const resultSeen = new Set<string>();

  for (let i = anchor + 1; i < events.length; i++) {
    const e = events[i]; const p = e.payload as any;
    st.eventCount++;
    switch (e.kind) {
      case 'turn.started':
        if (e.turn_id === turnId) { st.status = 'running'; st.step = 0; st.pendingCalls = []; st.suspended = undefined; }
        break;
      case 'user.message':
        st.msgs.push({ role: 'user', content: String(p.text ?? '') });
        break;
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
      case 'turn.finished':
        if (e.turn_id === turnId) st.status = 'finished';
        break;
    }
  }
  // 投影清洗:剔除悬空 tool_calls(并发重跑/崩溃可能留下无 result 的孤儿 call;
  // 喂给 OpenAI 协议会因「tool_calls 后缺 tool 消息」400,毒害整个 thread)
  const pendingIds = new Set(st.pendingCalls.map(c => c.id));
  st.msgs = st.msgs.filter(m => {
    if (m.role !== 'assistant' || !m.tool_calls) return true;
    m.tool_calls = m.tool_calls.filter(c => resultSeen.has(c.id) || pendingIds.has(c.id) || st.suspended?.tool_call_id === c.id);
    if (!m.tool_calls.length) m.tool_calls = undefined;
    return !!(m.content || m.reasoning_content || m.tool_calls);   // 清洗后彻底空的 assistant 消息一并剔除
  });
  return st;
}
