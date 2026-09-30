/** LLM provider 抽象:统一 OpenAI-compatible 协议。 */
import type { ChatMsg, ChatResult, ChatDelta, ToolSpec } from '../../../../packages/protocol/src/index.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { MockProvider } from './mock.js';

export interface ChatProvider {
  name: string;
  /** signal 中止时应尽快 reject(断开底层流),不必返回部分结果。 */
  chat(msgs: ChatMsg[], tools: ToolSpec[], onDelta: (d: ChatDelta) => void, signal?: AbortSignal): Promise<ChatResult>;
  summarize(text: string): Promise<string>;
}

export function makeProvider(): ChatProvider {
  const dsKey = process.env.DS_API_KEY;
  const kind = process.env.PROVIDER ?? ((process.env.PROVIDER_API_KEY || dsKey) ? 'openai-compat' : 'mock');
  if (kind === 'mock') {
    console.log('[llm] Mock provider(零成本;配 PROVIDER_API_KEY 或 DS_API_KEY 接真模型)');
    return new MockProvider();
  }
  const apiKey = process.env.PROVIDER_API_KEY ?? dsKey ?? '';
  const usingDs = !process.env.PROVIDER_API_KEY && !!dsKey;
  const baseUrl = process.env.PROVIDER_BASE_URL ?? (usingDs ? 'https://api.deepseek.com' : 'https://api.openai.com/v1');
  // DeepSeek 最佳实践:用最新对话模型 + thinking 参数控制思考,而非 deepseek-chat/reasoner 二选一
  const model = process.env.PROVIDER_MODEL ?? (usingDs ? 'deepseek-v4-pro' : 'gpt-4o-mini');
  const thinking = (process.env.PROVIDER_THINKING ?? 'enabled') as 'enabled' | 'disabled';
  const effort = process.env.PROVIDER_EFFORT ?? 'high';
  console.log(`[llm] OpenAI-compatible: ${baseUrl} · ${model} · thinking=${thinking}(effort=${effort})${usingDs ? ' · via DS_API_KEY' : ''}`);
  return new OpenAICompatProvider(baseUrl, apiKey, model, usingDs ? { thinking, effort } : {});
}
