/** OpenAI-compatible chat.completions 适配器(SSE 流式 + tool calling + DeepSeek 思考模式)。
 * DeepSeek 最佳实践(api-docs.deepseek.com/zh-cn/guides/thinking_mode):
 *  - thinking: {type:"enabled"}(默认开)+ reasoning_effort 控制强度
 *  - 工具调用轮次的 reasoning_content 必须随 assistant 消息回传,否则 400 */
import type { ChatMsg, ChatResult, ChatDelta, ToolSpec, ToolCallReq, Usage } from '../../../../packages/protocol/src/index.js';
import type { ChatProvider } from './provider.js';

export interface CompatOpts { thinking?: 'enabled' | 'disabled'; effort?: string }

export class OpenAICompatProvider implements ChatProvider {
  name = 'openai-compat';
  constructor(private baseUrl: string, private apiKey: string, private model: string, private opts: CompatOpts = {}) {}

  private toWire(msgs: ChatMsg[]) {
    return msgs.map(m => {
      if (m.role === 'assistant') {
        const w: any = { role: 'assistant', content: m.content || null };
        if (m.reasoning_content) w.reasoning_content = m.reasoning_content;   // 思考模式契约
        if (m.tool_calls?.length) w.tool_calls = m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
        return w;
      }
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      return { role: m.role, content: m.content };
    });
  }

  async chat(msgs: ChatMsg[], tools: ToolSpec[], onDelta: (d: ChatDelta) => void, signal?: AbortSignal): Promise<ChatResult> {
    const body: any = {
      model: this.model, stream: true, messages: this.toWire(msgs),
      stream_options: { include_usage: true },
    };
    if (tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (this.opts.thinking) body.thinking = { type: this.opts.thinking };
    if (this.opts.effort) body.reasoning_effort = this.opts.effort;

    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let text = ''; let reasoning = ''; let usage: Usage | undefined;
    const calls = new Map<number, { id: string; name: string; args: string; started: boolean; lastEmit: number }>();
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: any; try { j = JSON.parse(data); } catch { continue; }
        // 缓存命中数各家字段不同:DeepSeek 是 prompt_cache_hit_tokens,OpenAI 是 prompt_tokens_details.cached_tokens
        if (j.usage) usage = {
          prompt_tokens: j.usage.prompt_tokens ?? 0, completion_tokens: j.usage.completion_tokens ?? 0,
          cached_tokens: j.usage.prompt_cache_hit_tokens ?? j.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
        const delta = j.choices?.[0]?.delta; if (!delta) continue;
        if (delta.reasoning_content) { reasoning += delta.reasoning_content; onDelta({ kind: 'reasoning', delta: delta.reasoning_content }); }
        if (delta.content) { text += delta.content; onDelta({ kind: 'text', delta: delta.content }); }
        for (const tc of delta.tool_calls ?? []) {
          const slot = calls.get(tc.index) ?? { id: '', name: '', args: '', started: false, lastEmit: 0 };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
          // 参数生成是长过程(如 write_document 的整篇正文),流式上报,前端不再"死寂"
          if (!slot.started && slot.id && slot.name) { slot.started = true; onDelta({ kind: 'tool-start', id: slot.id, name: slot.name }); }
          if (slot.started && slot.args.length - slot.lastEmit >= 400) { slot.lastEmit = slot.args.length; onDelta({ kind: 'tool-args', id: slot.id, name: slot.name, chars: slot.args.length }); }
        }
      }
    }
    const tool_calls: ToolCallReq[] = [...calls.values()].map((c, i) => ({
      id: c.id || `call_${i}`, name: c.name, args: safeJson(c.args) }));
    return { text, reasoning: reasoning || undefined, tool_calls, usage };
  }

  async summarize(msgs: ChatMsg[], tools: ToolSpec[]): Promise<string> {
    // 不能传 tool_choice: 'none' —— 实测 DeepSeek 会因此不渲染工具定义,前缀一变整段 miss
    const r = await this.chat([...msgs, { role: 'user', content: SUMMARIZE }], tools, () => {});
    return r.text;
  }
}
const SUMMARIZE = '把以上对话压缩成 300 字以内的中文摘要,保留关键事实、决定、文件路径与未决问题;'
  + '开头若有【此前对话摘要】,把它的要点并进来。只输出摘要正文,不要调用任何工具。';
function safeJson(s: string): Record<string, unknown> { try { return JSON.parse(s || '{}'); } catch { return { _raw: s }; } }
