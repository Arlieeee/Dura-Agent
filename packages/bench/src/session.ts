/** 会话评测:同一个 thread 连续多轮真实开发请求,中途会触发 compaction。
 *
 * 单题 bench 每格只跑一个 turn,量不到"跨 turn + 压缩"这条路径 —— 而长会话恰恰是前缀缓存
 * 最值钱、也最容易被悄悄打破的地方(system 里塞了会变的东西、摘要请求另起前缀……)。
 * 这里记录**每一次** LLM 调用的 prompt / 命中 token,包括 compaction 的摘要调用,
 * 最后一轮再问第 1 轮给出的事实,顺带检查压缩有没有把它弄丢。
 *
 *   npm run bench:session -w packages/bench -- --models deepseek-flash,deepseek-v4-pro --repeat 2
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatDelta, ChatMsg, ChatResult, ToolSpec } from '../../../packages/protocol/src/index.js';
import { OpenAICompatProvider } from '../../../apps/server/src/llm/openai-compat.js';
import { MemoryStore, eventId } from '../../../apps/server/src/store.js';
import { runTurn, newThreadId, newTurnId } from '../../../apps/server/src/engine/runner.js';
import { openWorkspace } from '../../../apps/server/src/workspace.js';
import { loadLocalEnv } from '../../../apps/server/src/env.js';
import { hardTasks } from './tasks/hard.js';
import { withTimeout } from './harness/raw.js';

const TURNS = [
  '先熟悉一下这个项目:services/ 下有哪些子系统,各自的 api.js 导出了哪些函数?简要列出。另外记住:这个项目的发布负责人是 Alice。',
  'auth 子系统里 verifyToken 一共被调用了几次?分别在哪些文件里?',
  '给 services/billing/api.js 的每个导出函数上方加一行 JSDoc 注释,说明它是 billing 子系统的接口。',
  '在 services/search/ 下新建 README.md,列出 search 的三个函数和各自被调用的次数。',
  '把 services/auth/api.js 里的 hashPassword 重命名为 hashSecret,并同步修改所有调用处。',
  '用 bash 统计一下 services/ 下每个子系统的 .js 文件总行数。',
  '检查一下刚才的重命名有没有遗漏:全项目还能搜到 hashPassword 吗?',
  '把这次会话里做过的改动整理成 CHANGELOG.md,每条一行。',
  '这个项目的发布负责人是谁?只把名字写进 owner.txt,不要写别的。',
];

interface Call { kind: 'chat' | 'summarize'; prompt: number; cached: number; completion: number }

/** 记下每一次调用的 usage。摘要调用在实现里走的也是 this.chat,所以子类能一并截到。 */
class MeteredProvider extends OpenAICompatProvider {
  calls: Call[] = [];
  private summarizing = false;
  async chat(msgs: ChatMsg[], tools: ToolSpec[], onDelta: (d: ChatDelta) => void, signal?: AbortSignal): Promise<ChatResult> {
    const out = await super.chat(msgs, tools, onDelta, signal);
    const u = out.usage;
    this.calls.push({ kind: this.summarizing ? 'summarize' : 'chat', prompt: u?.prompt_tokens ?? 0, cached: u?.cached_tokens ?? 0, completion: u?.completion_tokens ?? 0 });
    return out;
  }
  async summarize(...args: Parameters<OpenAICompatProvider['summarize']>): Promise<string> {
    this.summarizing = true;
    try { return await super.summarize(...args); } finally { this.summarizing = false; }
  }
}

const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'deepseek-flash': { input: 0.15, output: 0.6, cacheRead: 0.003 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022 },
};
const costOf = (model: string, calls: Call[]) => {
  const p = PRICING[model] ?? { input: 0, output: 0, cacheRead: 0 };
  return calls.reduce((a, c) => a + ((c.prompt - c.cached) * p.input + c.cached * p.cacheRead + c.completion * p.output) / 1e6, 0);
};

export interface SessionResult {
  model: string; rep: number; calls: Call[]; compactions: number; checks: Record<string, boolean>; errors: string[]; wallMs: number;
}

export async function runSession(model: string, rep: number): Promise<SessionResult> {
  const t0 = Date.now();
  const dir = await mkdtemp(path.join(tmpdir(), 'session-'));
  try {
    const setup = hardTasks.find(t => t.id === 'hard-04-three-subsystems')!.setup;
    for (const [rel, content] of Object.entries(setup)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), content, 'utf8');
    }
    const ws = await openWorkspace(dir);
    const provider = new MeteredProvider(process.env.PROVIDER_BASE_URL ?? 'https://api.deepseek.com',
      process.env.PROVIDER_API_KEY ?? process.env.DS_API_KEY ?? '', model, { thinking: 'disabled', effort: 'medium' });
    const store = new MemoryStore();
    const threadId = newThreadId();
    await store.createThread(threadId, 'session', 'bench');
    const errors: string[] = [];
    // 会话之间只共享 system + 工具定义(真实部署里也是这样),对话本身各不相同
    const salt = `(会话 ${Math.random().toString(36).slice(2, 8)})\n`;

    for (const [i, text] of TURNS.entries()) {
      const turnId = newTurnId();
      await store.append({ id: eventId(turnId, 'turn.started', 'i'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: {} });
      await store.append({ id: eventId(turnId, 'user.message', 'i'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text: i === 0 ? salt + text : text } });
      try {
        await withTimeout(runTurn({ store, provider, toolset: 'coding', workspace: ws, maxSteps: 12, memoryDir: null }, threadId, turnId), 240_000);
      } catch (err: any) {
        errors.push(`turn ${i + 1}: ${String(err?.message ?? err).slice(0, 160)}`);
      }
    }

    const events = await store.load(threadId);
    const grepAll = async (needle: string) => {
      for (const f of await ws.list('services')) if (!f.endsWith('/') && (await ws.read(f)).includes(needle)) return true;
      return false;
    };
    const checks = {
      'owner.txt = Alice(压缩后仍记得)': (await ws.exists('owner.txt')) && (await ws.read('owner.txt')).trim() === 'Alice',
      '重命名无遗漏': !(await grepAll('hashPassword')) && await grepAll('hashSecret'),
      'search/README.md 已建': await ws.exists('services/search/README.md'),
      'CHANGELOG.md 已建': await ws.exists('CHANGELOG.md'),
    };
    return {
      model, rep, calls: provider.calls, compactions: events.filter(e => e.kind === 'compaction.summary').length,
      checks, errors, wallMs: Date.now() - t0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function renderSessions(results: SessionResult[]): string {
  const pct = (a: number, b: number) => (b ? (a / b * 100).toFixed(1) + '%' : '—');
  const L = ['| 模型 | 会话 | LLM 调用 | 其中摘要调用 | 总 prompt token | 缓存命中 | 摘要调用命中 | 压缩次数 | 检查通过 | 成本 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of results) {
    const all = r.calls, sum = all.filter(c => c.kind === 'summarize');
    const p = all.reduce((a, c) => a + c.prompt, 0), h = all.reduce((a, c) => a + c.cached, 0);
    const sp = sum.reduce((a, c) => a + c.prompt, 0), sh = sum.reduce((a, c) => a + c.cached, 0);
    const passed = Object.values(r.checks).filter(Boolean).length;
    L.push(`| ${r.model} | #${r.rep} | ${all.length} | ${sum.length} | ${p.toLocaleString()} | ${pct(h, p)} | ${pct(sh, sp)} | ${r.compactions} | ${passed}/${Object.keys(r.checks).length} | $${costOf(r.model, all).toFixed(4)} |`);
  }
  return L.join('\n');
}

async function main() {
  loadLocalEnv();
  process.env.ENABLE_BASH = '1';
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const models = (arg('models') ?? 'deepseek-flash').split(',').map(s => s.trim());
  const repeat = Number(arg('repeat') ?? 1);
  const jobs = models.flatMap(m => Array.from({ length: repeat }, (_, rep) => ({ m, rep })));
  console.log(`会话评测:${models.join(', ')} × ${repeat} 次,每个会话 ${TURNS.length} 轮`);
  const results = await Promise.all(jobs.map(({ m, rep }) => runSession(m, rep)));
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'results');
  await mkdir(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(path.join(out, `session-${stamp}.json`), JSON.stringify(results, null, 2), 'utf8');
  console.log('\n' + renderSessions(results));
  for (const r of results) if (r.errors.length) console.log(`${r.model} #${r.rep} 出错:`, r.errors.join(' | '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => { console.error('会话评测失败:', err); process.exit(1); });
}
