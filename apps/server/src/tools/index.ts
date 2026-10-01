/** 工具注册表。server tool 在 runner 里执行;client tool 触发挂起等用户。
 *
 * 可插拔:一个工具 = spec(给模型看)+ impl(给 runner 跑),用 defineTool 一次登记完。
 * 分组(toolset)让同一套引擎能穿两种"人格":chat 偏问答/文档,coding 偏文件/命令行。
 * bench 靠它精确控变量——同一 harness 同一模型,只换工具集就能看出工具面的贡献。 */
import type { ToolSpec } from '../../../../packages/protocol/src/index.js';
import { webSearch } from './web-search.js';
import { writeDocument } from './write-document.js';
import { readFileTool, writeFileTool, editFileTool, listFilesTool, grepFilesTool } from './fs.js';
import { bashTool, bashEnabled } from './bash.js';
import { delegateTool } from './delegate.js';
import { rememberTool, recallTool } from './memory.js';
import type { MemoryDir } from '../memory.js';
import type { Executor } from '../executor.js';
import type { EventStore } from '../store.js';
import type { WorkspaceLike } from '../workspace.js';

export interface ToolCtx {
  store: EventStore;
  threadId: string;
  turnId: string;
  progress: (data: unknown) => void;
  workspace: WorkspaceLike;
  /** 由 runner 注入的子 agent 入口。放在 ctx 里而不是让工具 import runner,
   *  是为了不制造 tools ⇄ runner 的循环依赖。未注入时 delegate 工具不上架。 */
  spawn?: SpawnFn;
  /** 技能声明的工具白名单;null/undefined = 不设限。执行前会再查一次。 */
  allowedTools?: Set<string> | null;
  /** 跨 session 记忆目录;未注入时 remember/recall 不上架。 */
  memory?: MemoryDir;
  /** 命令执行器。docker 模式下 bash 进容器跑;不注入则宿主机直跑。 */
  executor?: Executor;
}
export type SpawnFn = (goal: string, opts?: { toolset?: string; maxSteps?: number })
  => Promise<{ text: string; llmCalls: number; toolCalls: number }>;
export type ToolFn = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;

export type ToolGroup = 'chat' | 'coding' | 'memory';
export interface ToolDef extends ToolSpec {
  group: ToolGroup;
  run?: ToolFn;
  /** 只读、无副作用 → 同一批里可以并发跑。默认 false(按串行处理)。 */
  parallelSafe?: boolean;
  /** 执行到一半崩溃后可以直接重跑:重跑与跑一次效果相同(整文件覆盖写、确定性子任务)。
   *  只读工具天然满足,不用再标。默认 false:崩溃后不重跑,改给模型一个 interrupted 结果。 */
  replaySafe?: boolean;
}

const REGISTRY = new Map<string, ToolDef>();

/** 登记一个工具。同名后登记的覆盖前者(便于宿主应用替换内置实现)。 */
export function defineTool(def: ToolDef): ToolDef { REGISTRY.set(def.name, def); return def; }

const str = (description: string) => ({ type: 'string', description });

/* ---------- chat 工具集:问答/研究/文档 ---------- */
defineTool({
  name: 'web_search', group: 'chat', parallelSafe: true, run: webSearch,
  description: '联网搜索。输入查询词,返回标题+链接+摘要列表。',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
});
defineTool({
  name: 'write_document', group: 'chat', run: writeDocument,
  description: '把内容写成一篇 markdown 在线文档(artifact),返回可访问的文档链接。适合输出报告/教程/长文。',
  parameters: {
    type: 'object',
    properties: { title: { type: 'string' }, content: str('markdown 正文') },
    required: ['title', 'content'],
  },
});
defineTool({
  name: 'ask_user', group: 'chat', client: true,
  description: '向用户提一个澄清问题(可带选项),挂起等待答复。需求不明确时优先使用。',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    required: ['question'],
  },
});

/* ---------- coding 工具集:文件与命令行 ---------- */
defineTool({
  name: 'read_file', group: 'coding', parallelSafe: true, run: readFileTool,
  description: '读取工作区内的文件。默认每行带「行号+Tab」前缀便于引用,该前缀不属于文件内容;'
    + '要把内容原样复制到别处时传 raw=true。大文件用 offset/limit 分段读。',
  parameters: {
    type: 'object',
    properties: {
      path: str('工作区相对路径'),
      offset: { type: 'integer', description: '起始行(0 基),默认 0' },
      limit: { type: 'integer', description: '读多少行,默认 2000' },
      raw: { type: 'boolean', description: 'true = 不加行号,返回原样内容。要复制/转写文件内容时用它' },
    },
    required: ['path'],
  },
});
defineTool({
  name: 'write_file', group: 'coding', replaySafe: true, run: writeFileTool,
  description: '写入文件(存在则整体覆盖,父目录自动创建)。改动已有文件的局部请优先用 edit_file。',
  parameters: {
    type: 'object',
    properties: { path: str('工作区相对路径'), content: str('完整文件内容') },
    required: ['path', 'content'],
  },
});
defineTool({
  name: 'edit_file', group: 'coding', run: editFileTool,
  description: '精确替换文件里的一段文本。old_string 必须与原文逐字符一致(含缩进),且在文件中唯一。',
  parameters: {
    type: 'object',
    properties: {
      path: str('工作区相对路径'),
      old_string: str('待替换的原文片段,必须唯一'),
      new_string: str('替换成的新文本'),
      replace_all: { type: 'boolean', description: '替换全部匹配,默认 false' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
});
defineTool({
  name: 'list_files', group: 'coding', parallelSafe: true, run: listFilesTool,
  description: '递归列出工作区目录下的文件(跳过 node_modules/.git)。',
  parameters: { type: 'object', properties: { path: str('目录相对路径,默认 .') } },
});
defineTool({
  name: 'grep_files', group: 'coding', parallelSafe: true, run: grepFilesTool,
  description: '在工作区文件内容里按正则搜索,返回 路径:行号:内容。',
  parameters: {
    type: 'object',
    properties: { pattern: str('JS 正则'), path: str('限定目录或单个文件,默认 .') },
    required: ['pattern'],
  },
});
defineTool({
  name: 'delegate', group: 'coding', replaySafe: true, run: delegateTool,
  description: '把一个自成一体的子任务交给子 agent 独立完成,只返回它的结论。'
    + '适合"需要翻很多文件才能得出一个答案"的活:子 agent 的探索过程不会占用你的上下文。'
    + 'goal 要写成一句自足的指令(子 agent 看不到当前对话)。',
  parameters: {
    type: 'object',
    properties: {
      goal: str('给子 agent 的完整指令,必须自足——它看不到当前对话历史'),
      max_steps: { type: 'integer', description: '子 agent 的 LLM 调用预算,默认 8' },
    },
    required: ['goal'],
  },
});
defineTool({
  name: 'bash', group: 'coding', run: bashTool,
  description: '在工作区内执行 shell 命令,返回 exit_code/stdout/stderr。用于跑测试、编译、查看环境。',
  parameters: {
    type: 'object',
    properties: { command: str('要执行的 shell 命令') },
    required: ['command'],
  },
});

/* ---------- memory 工具集:跨 session 记忆 ---------- */
defineTool({
  name: 'remember', group: 'memory', replaySafe: true, run: rememberTool,
  description: '把一条值得跨会话保留的事实写进长期记忆(用户偏好、项目约定、踩过的坑)。'
    + '只记"下次还用得上"的东西;一次性的中间结果不要记。同名会覆盖。',
  parameters: {
    type: 'object',
    properties: {
      name: str('短标题,同时用作文件名'),
      description: str('一句话说明这条记忆讲什么 —— 检索时先看它,写清楚点'),
      body: str('记忆正文'),
      type: str('user | project | feedback | reference,默认 note'),
    },
    required: ['name', 'body'],
  },
});
defineTool({
  name: 'recall', group: 'memory', parallelSafe: true, run: recallTool,
  description: '按关键词在长期记忆里检索,返回最相关的几条全文。'
    + '系统提示词里已有记忆索引,看到相关条目再用这个取正文。',
  parameters: {
    type: 'object',
    properties: { query: str('检索词'), limit: { type: 'integer', description: '最多返回几条,默认 3' } },
    required: ['query'],
  },
});

/** 当前启用的工具集。TOOLSET=chat(默认) | coding | full;bash 另需 ENABLE_BASH=1。 */
export interface ToolFilter { spawn?: boolean; allow?: Set<string> | null; memory?: boolean }

export function activeTools(toolset = process.env.TOOLSET ?? 'chat', opts: ToolFilter = {}): ToolDef[] {
  // memory 组是横切的:哪个场景都可能要记东西,所以只要注入了记忆目录就带上
  const groups: ToolGroup[] = toolset === 'full' ? ['chat', 'coding'] : [toolset as ToolGroup];
  if (opts.memory) groups.push('memory');
  return [...REGISTRY.values()].filter(t =>
    groups.includes(t.group)
    && (t.name !== 'bash' || bashEnabled())
    // delegate 依赖 runner 注入 spawn;拿不到就别摆上货架,免得模型调了才发现没实现
    && (t.name !== 'delegate' || opts.spawn === true)
    // 技能白名单:第一道防线是不上架 —— 模型看不见的工具不会去调
    && (!opts.allow || opts.allow.has(t.name)));
}

/** 喂给 LLM 的 spec(剥掉 group/run/parallelSafe 这些内部字段,别把调度细节漏给模型) */
export const toolSpecs = (toolset?: string, opts?: ToolFilter): ToolSpec[] =>
  activeTools(toolset, opts).map(({ group: _g, run: _r, parallelSafe: _p, replaySafe: _s, ...spec }) => spec);

export const isClientTool = (name: string) => REGISTRY.get(name)?.client === true;
export const isParallelSafe = (name: string) => REGISTRY.get(name)?.parallelSafe === true;
export const isReplaySafe = (name: string) => isParallelSafe(name) || REGISTRY.get(name)?.replaySafe === true;

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolCtx): Promise<{ ok: boolean; output: unknown }> {
  // 第二道防线:即使没上架,模型也可能凭空编出工具名(幻觉或提示词注入)。
  // 只靠"不上架"等于把安全建立在模型的自觉上。
  if (ctx.allowedTools && !ctx.allowedTools.has(name)) {
    return { ok: false, output: { error: `工具 ${name} 不在当前技能允许的范围内` } };
  }
  const fn = REGISTRY.get(name)?.run;
  if (!fn) return { ok: false, output: { error: `unknown tool: ${name}` } };
  try {
    return { ok: true, output: await fn(args, ctx) };
  } catch (err: any) {
    return { ok: false, output: { error: String(err?.message ?? err) } };
  }
}

/** @deprecated 用 toolSpecs();保留给旧引用 */
export const TOOL_SPECS: ToolSpec[] = toolSpecs();
