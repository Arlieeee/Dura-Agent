/** bench 用的 provider 工厂:三档 harness 共用同一实现、同一端点、同一参数。
 * 唯一被允许变化的是 model 名——不然分差就不再只归因于 harness 了。 */
import { OpenAICompatProvider } from '../../../apps/server/src/llm/openai-compat.js';
import type { ChatProvider } from '../../../apps/server/src/llm/provider.js';
import type { ChatDelta, ChatMsg, ToolSpec } from '../../../packages/protocol/src/index.js';

/** 每次跑分一个随机盐,加在 system 最前面:同一次跑分里各题照常共享 system + 工具定义,
 *  跨次跑分互不沾光。服务端缓存能活几个小时 —— 不加盐的话,和上一次跑分逐字节相同的那一档
 *  连第 0 步都命中,改前 / 改后的对比就被"谁先跑过"污染了(实测过一次)。设成空串可关闭。 */
export const runSalt = () => process.env.BENCH_RUN_SALT ?? '';
export const withSalt = (msgs: ChatMsg[]): ChatMsg[] =>
  runSalt() && msgs[0]?.role === 'system' ? [{ ...msgs[0], content: `${runSalt()}\n${msgs[0].content}` }, ...msgs.slice(1)] : msgs;

class SaltedProvider extends OpenAICompatProvider {
  chat(msgs: ChatMsg[], tools: ToolSpec[], onDelta: (d: ChatDelta) => void, signal?: AbortSignal) {
    return super.chat(withSalt(msgs), tools, onDelta, signal);
  }
}

export function makeBenchProvider(model: string): ChatProvider {
  const apiKey = process.env.PROVIDER_API_KEY ?? process.env.DS_API_KEY ?? '';
  if (!apiKey) throw new Error('缺少 API key:设 DS_API_KEY 或 PROVIDER_API_KEY');
  const baseUrl = process.env.PROVIDER_BASE_URL ?? 'https://api.deepseek.com';
  // 思考模式默认关:bench 要比的是 harness,不是让某一档偷偷多花推理预算
  const thinking = (process.env.BENCH_THINKING ?? 'disabled') as 'enabled' | 'disabled';
  return new SaltedProvider(baseUrl, apiKey, model, { thinking, effort: process.env.BENCH_EFFORT ?? 'medium' });
}

export const benchModels = (): string[] =>
  (process.env.BENCH_MODELS ?? 'deepseek-flash').split(',').map(s => s.trim()).filter(Boolean);
