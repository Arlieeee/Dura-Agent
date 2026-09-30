/** harness #0:raw —— 不加 harness 的原生 API 基线。
 *
 * 一次 chat,无工具、无循环、无重试。为了公平,把初始工作区的**全部文件内容**塞进提示词
 * (它没有 read_file,不给就等于蒙眼答题),并要求以 JSON 交回最终文件,由 bench 代为落盘。
 * 这条线回答的问题是:"模型本身能做多少?agent harness 到底加了多少分?" */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Harness, Trace } from '../types.js';
import { makeBenchProvider } from '../provider.js';

const SYSTEM = `你是一个编程助手。你没有工具,只能一次性给出答案。
如果任务需要创建或修改文件,请在回答**最后**输出一个 JSON 代码块,格式:
\`\`\`json
{"files": {"相对路径": "完整文件内容", "...": "..."}}
\`\`\`
文件内容必须完整(不能用省略号),路径相对工作区根目录。只输出需要新建或改动的文件。
不需要改文件的任务,直接用文字回答。`;

export const rawHarness: Harness = {
  id: 'raw',
  describe: '原生 API 单次调用:无工具、无循环、无状态。工作区内容随提示词一次性给全。',

  async run(ctx): Promise<Trace> {
    const t0 = Date.now();
    const provider = makeBenchProvider(ctx.model);
    const steps: Trace['steps'] = [];

    const dump = Object.entries(ctx.task.setup)
      .map(([p, c]) => `----- ${p} -----\n${c}`).join('\n\n') || '(工作区为空)';
    const user = `${ctx.task.prompt}\n\n【工作区当前文件】\n${dump}`;

    try {
      const out = await withTimeout(
        provider.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], [], () => {}),
        ctx.budget.timeoutMs);

      steps.push({ kind: 'llm', text: out.text, promptTokens: out.usage?.prompt_tokens, completionTokens: out.usage?.completion_tokens });

      let written = await applyFileBlock(out.text, ctx.workspaceDir);
      // 兜底:单文件任务上,模型常常直接甩一个代码块而不包 JSON。
      // 不接住的话,这一档会因为**协议负担**而不是能力丢分 —— HumanEval 上实测
      // 10/20 的失败全是"没落盘"(文件还是原始 stub),而不是代码写错。
      // 评测协议给某一档强加的偏差,必须由评测框架自己吸收。
      if (!written.length) {
        const targets = Object.keys(ctx.task.setup);
        const code = lastCodeBlock(out.text);
        if (targets.length === 1 && code) {
          await writeFile(path.resolve(ctx.workspaceDir, targets[0]), code, 'utf8');
          written = [targets[0]];
        }
      }
      for (const p of written) steps.push({ kind: 'tool', name: 'write_file(代写)', args: { path: p }, ok: true });

      return {
        steps, finalText: out.text, llmCalls: 1, toolCalls: written.length, toolErrors: 0,
        promptTokens: out.usage?.prompt_tokens ?? 0, completionTokens: out.usage?.completion_tokens ?? 0, cachedTokens: out.usage?.cached_tokens,
        wallMs: Date.now() - t0, terminated: 'stop',
      };
    } catch (err: any) {
      const timeout = /timeout/i.test(String(err?.message));
      return {
        steps, finalText: '', llmCalls: 1, toolCalls: 0, toolErrors: 1,
        promptTokens: 0, completionTokens: 0, wallMs: Date.now() - t0,
        terminated: timeout ? 'timeout' : 'error', errorMessage: String(err?.message ?? err),
      };
    }
  },
};

/** 取回答里最后一个围栏代码块。单文件任务的兜底路径。 */
export function lastCodeBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  const code = blocks.length ? blocks[blocks.length - 1].trimEnd() : null;
  return code && code.trim() ? code : null;
}

/** 从回答里抠出 {"files": {...}} 并落盘。抠不到就当"纯文字回答",不算失败。 */
export async function applyFileBlock(text: string, dir: string): Promise<string[]> {
  const written: string[] = [];
  for (const raw of candidates(text)) {
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const files = parsed?.files;
    if (!files || typeof files !== 'object') continue;
    for (const [rel, content] of Object.entries(files)) {
      if (typeof content !== 'string') continue;
      const abs = path.resolve(dir, rel);
      if (abs !== path.resolve(dir) && !abs.startsWith(path.resolve(dir) + path.sep)) continue;   // 越界丢弃
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      written.push(rel);
    }
    if (written.length) break;
  }
  return written;
}

/** 依次尝试:```json 围栏 → 任意围栏 → 裸 {"files" 起始的平衡括号 */
function* candidates(text: string): Generator<string> {
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) yield m[1].trim();
  const i = text.indexOf('{"files"') >= 0 ? text.indexOf('{"files"') : text.search(/\{\s*"files"/);
  if (i >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { yield text.slice(i, j + 1); break; }
    }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms).unref?.())]);
}
