/** 评测协议。方法论抄自 Harness-Bench(arXiv:2605.27922):
 *  固定 [任务提示 / 初始沙箱 / 预算 / 超时 / 评分器],只变 [harness × model],
 *  这样分差才能归因到执行层而不是提示词或运气。
 *
 *  TaskScore = Security × Completion × Process
 *   - Security 是**乘法门**:越权即 0 分。一个会删 secrets 的 agent,任务做得再漂亮也不能给分。
 *   - Completion 是 oracle 判的客观完成度(0..1),不用 LLM 当裁判——裁判本身有偏差,而我们要比的正是模型。
 *   - Process 看过程质量:错误恢复、工具使用是否浪费、终态是否自洽。 */

export interface TaskBudget { maxSteps: number; timeoutMs: number }

export interface CheckResult {
  /** 0..1 客观完成度 */
  completion: number;
  /** 判分依据,写进报告便于复查 */
  notes: string[];
}

export interface BenchTask {
  id: string;
  category:
    | 'software-engineering' | 'data-analysis' | 'multi-file-refactor'
    | 'retrieval' | 'error-recovery' | 'long-horizon' | 'constraint-following';
  /** 一句话说明这题在考什么(报告里按类聚合) */
  probe: string;
  prompt: string;
  /** 初始沙箱:相对路径 → 文件内容 */
  setup: Record<string, string>;
  budget?: Partial<TaskBudget>;
  /** oracle:只看工作区终态和 agent 最终文本,不看轨迹 */
  check(ws: TaskWorkspace, finalText: string): Promise<CheckResult>;
  /** 安全门:返回违规原因则该题 0 分。不实现 = 无额外约束 */
  security?(ws: TaskWorkspace, trace: Trace): Promise<string | null>;
}

/** 判分器能看到的工作区视图(只读,避免 oracle 意外改状态) */
export interface TaskWorkspace {
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
  list(rel?: string): Promise<string[]>;
  root: string;
}

/* ---------- 轨迹:harness 无关的统一记录 ---------- */
export interface TraceStep {
  kind: 'llm' | 'tool' | 'error';
  name?: string;
  args?: unknown;
  ok?: boolean;
  output?: unknown;
  text?: string;
  promptTokens?: number;
  completionTokens?: number;
}
export interface Trace {
  steps: TraceStep[];
  finalText: string;
  llmCalls: number;
  toolCalls: number;
  toolErrors: number;
  promptTokens: number;
  completionTokens: number;
  wallMs: number;
  /** 预算耗尽 / 超时 / 崩溃 */
  terminated: 'stop' | 'max-steps' | 'timeout' | 'error';
  errorMessage?: string;
}

/* ---------- harness:被测对象 ---------- */
export interface HarnessCtx {
  task: BenchTask;
  budget: TaskBudget;
  /** harness 自己决定怎么用工具;bench 只保证工作区已按 setup 铺好 */
  workspaceDir: string;
  model: string;
}
export interface Harness {
  id: string;
  /** 报告里说明这一档"多了什么" */
  describe: string;
  run(ctx: HarnessCtx): Promise<Trace>;
}

/* ---------- 结果 ---------- */
export interface Score {
  security: 0 | 1;
  securityViolation?: string;
  completion: number;
  process: number;
  processBreakdown: { robustness: number; efficiency: number; coherence: number };
  taskScore: number;
  notes: string[];
}
export interface RunRecord {
  taskId: string;
  category: BenchTask['category'];
  harnessId: string;
  model: string;
  /** 第几次重复采样(0 基) */
  rep?: number;
  score: Score;
  trace: Omit<Trace, 'steps'> & { steps?: TraceStep[] };
}
