/** bench 用的 provider 工厂:三档 harness 共用同一实现、同一端点、同一参数。
 * 唯一被允许变化的是 model 名——不然分差就不再只归因于 harness 了。 */
import { OpenAICompatProvider } from '../../../apps/server/src/llm/openai-compat.js';
import type { ChatProvider } from '../../../apps/server/src/llm/provider.js';

export function makeBenchProvider(model: string): ChatProvider {
  const apiKey = process.env.PROVIDER_API_KEY ?? process.env.DS_API_KEY ?? '';
  if (!apiKey) throw new Error('缺少 API key:设 DS_API_KEY 或 PROVIDER_API_KEY');
  const baseUrl = process.env.PROVIDER_BASE_URL ?? 'https://api.deepseek.com';
  // 思考模式默认关:bench 要比的是 harness,不是让某一档偷偷多花推理预算
  const thinking = (process.env.BENCH_THINKING ?? 'disabled') as 'enabled' | 'disabled';
  return new OpenAICompatProvider(baseUrl, apiKey, model, { thinking, effort: process.env.BENCH_EFFORT ?? 'medium' });
}

export const benchModels = (): string[] =>
  (process.env.BENCH_MODELS ?? 'deepseek-v4-flash').split(',').map(s => s.trim()).filter(Boolean);
