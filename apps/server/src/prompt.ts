/** system prompt 构造。抽成独立模块的三个理由:
 *  1. 提示词是 harness 的一部分,评测时要能像换配置一样换它
 *  2. 按工具集分化(chat / coding),避免给聊天场景灌一堆文件操作规则
 *  3. Pi 的经验值得抄:核心提示词压在 1000 token 以内,规则越少模型越听话
 *     ——长提示词里的第 30 条规则,模型基本当没看见。 */
import type { ToolGroup } from './tools/index.js';

const CHAT = `你是 my-agent,一个会用工具完成任务的中文助手。
需求不明确时用 ask_user 澄清;要输出长内容时用 write_document 生成在线文档。`;

const CODING = `你是 my-agent,一个在隔离工作区里干活的编码助手。

工作方式:
- 所有路径都相对工作区根目录。改文件前先 read_file 看原文,别凭记忆改。
- 局部修改用 edit_file(old_string 必须逐字符抄原文且唯一);整文件重写才用 write_file。
- 不确定文件在哪就 list_files / grep_files,别猜路径。
- read_file 默认给的每行带「行号+Tab」前缀,那是显示用的。要把内容写去别处时先去掉它,或用 raw=true 重读。
- 有 bash 就用它验证(跑测试、看输出);没有就靠读文件自查。
- 做完直接给结论,不要复述过程。
- **别停下来等回话**:工具列表里没有提问工具时,把最合理的解释当作答案做完,
  在最后说明你按什么假设做的。发现路径/名称对不上就自己去找对的那个,找到了直接改。`;

export interface PromptCtx { groups: ToolGroup[]; summary?: string; skills?: string; workspaceHint?: string; memoryHint?: string }

export function buildSystemPrompt({ groups, summary, skills, workspaceHint, memoryHint }: PromptCtx): string {
  const base = groups.includes('coding') ? (groups.includes('chat') ? `${CODING}\n\n也可以联网搜索和生成在线文档。` : CODING) : CHAT;
  return [
    base,
    // 记忆排在工作区之前:它是"长期约定",应该先于本次任务的具体材料被读到
    memoryHint || '',
    workspaceHint ? `【工作区文件】\n${workspaceHint}` : '',
    summary ? `【此前对话摘要】${summary}` : '',
    skills ? `【可用技能】\n${skills}` : '',
  ].filter(Boolean).join('\n\n');
}
