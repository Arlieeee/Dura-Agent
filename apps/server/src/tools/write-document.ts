/** write_document:内容落为 artifact(在线 markdown 文档),返回链接。 */
import { randomUUID } from 'node:crypto';
import type { ToolFn } from './index.js';

export const writeDocument: ToolFn = async (args, ctx) => {
  const id = 'doc_' + randomUUID().slice(0, 8);
  const title = String(args.title ?? 'untitled');
  ctx.progress({ status: 'writing', title });
  await ctx.store.putArtifact({
    id, thread_id: ctx.threadId, title, kind: 'markdown',
    content: String(args.content ?? ''), created_at: new Date().toISOString(),
  });
  return { artifact_id: id, title, url: `/api/artifacts/${id}` };
};
