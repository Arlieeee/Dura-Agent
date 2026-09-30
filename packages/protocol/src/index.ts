/** 共享协议:事件(唯一真相)、SSE chunk(wire)、API DTO。零依赖。 */

/* ---------- 事件(持久化,追加式演进:只加不改) ---------- */
export type EventKind =
  | 'turn.started' | 'user.message' | 'assistant.message' | 'tool.call' | 'tool.result'
  | 'turn.suspended' | 'user.confirmation' | 'turn.finished' | 'compaction.summary'
  // 可重试失败的留痕:不终结 turn,只记一次尝试。终结用 turn.finished{reason:'error'}。
  // 区分这两者是收敛式重跑的前提——写了 turn.finished 的 turn,重投时 fold 只会得到 noop。
  | 'turn.error'
  // 用户喊停。是持久事实而不是进程内信号:崩溃重投后 fold 照样看得见,turn 收敛到 cancelled。
  | 'user.interrupt';

export type FinishReason = 'stop' | 'tool-calls' | 'error' | 'cancelled' | 'max-steps';

export interface AgentEvent {
  id: string;               // 确定性 ID(内容哈希)→ 写两次 = 写一次
  seq?: number;
  thread_id: string;
  turn_id: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  created_at?: string;
}

/* ---------- SSE chunk(wire,snake_case) ---------- */
export type Chunk =
  | { type: 'start'; thread_id: string; turn_id: string }
  | { type: 'reasoning-delta'; step: number; delta: string }
  | { type: 'text-delta'; step: number; delta: string }
  | { type: 'tool-input-start'; step: number; tool_call_id: string; tool_name: string }
  | { type: 'tool-input-delta'; tool_call_id: string; tool_name: string; chars: number }
  | { type: 'tool-input-available'; step: number; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool-progress'; tool_call_id: string; data: unknown }
  | { type: 'tool-output-available'; tool_call_id: string; output: unknown; ok: boolean }
  | { type: 'suspend'; tool_call_id: string; question: string; options?: string[] }
  | { type: 'usage'; step: number; prompt_tokens: number; completion_tokens: number }
  | { type: 'finish'; finish_reason: FinishReason };

/* ---------- LLM provider 抽象 ---------- */
export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_content?: string;            // DeepSeek 思考模式:工具调用轮次必须回传
  tool_call_id?: string;
  tool_calls?: ToolCallReq[];
}
export interface ToolCallReq { id: string; name: string; args: Record<string, unknown> }
export interface ToolSpec {
  name: string; description: string; parameters: Record<string, unknown>; client?: boolean;
}
export interface Usage { prompt_tokens: number; completion_tokens: number }
export interface ChatResult { reasoning?: string; text: string; tool_calls: ToolCallReq[]; usage?: Usage }
export type ChatDelta =
  | { kind: 'reasoning' | 'text'; delta: string }
  | { kind: 'tool-start'; id: string; name: string }
  | { kind: 'tool-args'; id: string; name: string; chars: number };

/* ---------- API DTO ---------- */
export interface ThreadView { id: string; title: string; created_at: string }
export interface TurnInput { text: string }
export interface ContinueInput { turn_id: string; tool_call_id: string; answer: string }
export interface ArtifactView { id: string; title: string; kind: string; created_at: string }
