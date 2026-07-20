/** Mock provider:确定性规则脚本,零成本跑通全链路(搜索 → 追问挂起 → 写文档 → 总结)。
 * 确定性输出 = 收敛式重跑可完美演示(kill 后重放得到同样决策)。 */
import type { ChatMsg, ChatResult, ChatDelta, ToolSpec } from '../../../../packages/protocol/src/index.js';
import type { ChatProvider } from './provider.js';
import { createHash } from 'node:crypto';

export class MockProvider implements ChatProvider {
  name = 'mock';

  async chat(msgs: ChatMsg[], _tools: ToolSpec[], onDelta: (d: ChatDelta) => void): Promise<ChatResult> {
    const userText = [...msgs].reverse().find(m => m.role === 'user')?.content ?? '';
    const toolResults = msgs.filter(m => m.role === 'tool');
    const hasSearch = msgs.some(m => m.tool_calls?.some(c => c.name === 'web_search'));
    const hasAsk = msgs.some(m => m.tool_calls?.some(c => c.name === 'ask_user'));
    const hasDoc = msgs.some(m => m.tool_calls?.some(c => c.name === 'write_document'));
    const stableId = (k: string) => 'call_' + createHash('sha1').update(userText + k).digest('hex').slice(0, 8);
    const stream = async (kind: 'reasoning' | 'text', s: string) => {
      for (const chunk of s.match(/.{1,8}/g) ?? []) { onDelta({ kind, delta: chunk }); await sleep(20); }
    };

    if (!hasSearch) {
      await stream('reasoning', `用户想要:「${userText.slice(0, 40)}」。先联网搜索获取材料。`);
      return { reasoning: 'plan: search first', text: '', tool_calls: [{ id: stableId('s'), name: 'web_search', args: { query: userText.slice(0, 80) } }] };
    }
    if (!hasAsk) {
      await stream('reasoning', '拿到搜索结果。输出形式不明确,询问用户。');
      return { reasoning: 'clarify output format', text: '',
        tool_calls: [{ id: stableId('a'), name: 'ask_user', args: { question: '结果想要什么形式?', options: ['整理成在线文档', '直接在对话里回答'] } }] };
    }
    const answer = String(toolResults[toolResults.length - 1]?.content ?? '');
    if (!hasDoc && answer.includes('文档')) {
      await stream('reasoning', '用户要文档,调用 write_document。');
      return { reasoning: 'write doc', text: '', tool_calls: [{ id: stableId('d'), name: 'write_document',
        args: { title: `关于「${userText.slice(0, 24)}」的整理`, content: `# ${userText}\n\n> 由 dura-agent(mock)基于搜索结果生成\n\n## 要点\n\n${summarizeTools(toolResults)}\n` } }] };
    }
    const final = hasDoc || answer.includes('文档')
      ? '已生成在线文档 ✅ 点击上方工具卡片里的链接查看。还需要补充或改写吗?'
      : `根据搜索结果的直接回答:${summarizeTools(toolResults).slice(0, 300)}(mock 模式;接真实 LLM 后此处为模型生成)`;
    await stream('text', final);
    return { text: final, tool_calls: [] };
  }

  async summarize(text: string): Promise<string> {
    return '【摘要】' + text.replace(/\s+/g, ' ').slice(0, 200);
  }
}
function summarizeTools(toolMsgs: ChatMsg[]): string {
  return toolMsgs.map(m => '- ' + m.content.slice(0, 160)).join('\n') || '- (无工具结果)';
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
