/** 工具注册表。server tool 在 runner 里执行;client tool 触发挂起等用户。 */
import type { ToolSpec } from '../../../../packages/protocol/src/index.js';
import { webSearch } from './web-search.js';
import { writeDocument } from './write-document.js';
import type { EventStore } from '../store.js';

export interface ToolCtx { store: EventStore; threadId: string; turnId: string; progress: (data: unknown) => void }
export type ToolFn = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'web_search',
    description: '联网搜索。输入查询词,返回标题+链接+摘要列表。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'write_document',
    description: '把内容写成一篇 markdown 在线文档(artifact),返回可访问的文档链接。适合输出报告/教程/长文。',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string', description: 'markdown 正文' } },
      required: ['title', 'content'],
    },
  },
  {
    name: 'ask_user',
    description: '向用户提一个澄清问题(可带选项),挂起等待答复。需求不明确时优先使用。',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      required: ['question'],
    },
    client: true,
  },
];

const CLIENT_TOOLS = new Set(TOOL_SPECS.filter(t => t.client).map(t => t.name));
export const isClientTool = (name: string) => CLIENT_TOOLS.has(name);

const impls: Record<string, ToolFn> = {
  web_search: webSearch,
  write_document: writeDocument,
};

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<{ ok: boolean; output: unknown }> {
  const fn = impls[name];
  if (!fn) return { ok: false, output: { error: `unknown tool: ${name}` } };
  try {
    return { ok: true, output: await fn(args, ctx) };
  } catch (err: any) {
    return { ok: false, output: { error: String(err?.message ?? err) } };
  }
}
