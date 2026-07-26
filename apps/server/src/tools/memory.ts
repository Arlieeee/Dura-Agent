/** remember / recall:跨 session 的记忆读写。
 *
 * 设计上刻意让 agent **显式**决定记什么、什么时候取,而不是后台自动抽取:
 * 自动抽取要么记一堆噪音,要么漏掉真正重要的;而且它不可测 —— 没法写一个断言说
 * "这次该记住"。显式工具调用会落进事件日志,评测能直接查它有没有记、记了什么。 */
import type { ToolFn } from './index.js';

export const rememberTool: ToolFn = async (args, ctx) => {
  if (!ctx.memory) throw new Error('当前运行环境未启用记忆');
  const name = String(args.name ?? '').trim();
  const description = String(args.description ?? '').trim();
  const body = String(args.body ?? '').trim();
  if (!name || !body) throw new Error('name 与 body 都不能为空');

  ctx.progress({ status: 'remembering', name });
  const r = await ctx.memory.write(name, description || name, body, String(args.type ?? 'note'));
  return { name, file: r.file, action: r.updated ? 'updated' : 'created' };
};

export const recallTool: ToolFn = async (args, ctx) => {
  if (!ctx.memory) throw new Error('当前运行环境未启用记忆');
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query 不能为空');

  ctx.progress({ status: 'recalling', query: query.slice(0, 80) });
  const hits = await ctx.memory.search(query, Math.min(Number(args.limit ?? 3), 5));
  if (!hits.length) return { query, found: 0, note: '没有相关记忆。索引里没有就是真没有,别编。' };
  return {
    query, found: hits.length,
    memories: hits.map(m => ({ name: m.name, description: m.description, content: m.body.slice(0, 3000) })),
  };
};
