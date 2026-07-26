/** 命令执行器:把"在哪儿跑命令"从工具里抽出来。
 *
 * 为什么要这层:`bash.ts` 顶部一直挂着一句诚实的声明 —— 路径级隔离**不是沙箱**,
 * 它挡得住 `../../etc/passwd`,挡不住 bash 里的 `cd /`。要真隔离只有一条路:
 * 把命令放进容器里跑。而这件事又是接 SWE-bench 这类"真实 repo + 装依赖 + 跑测试"
 * 评测的前提 —— 那些任务不可能在宿主机上跑。
 *
 * 抽象只有一个方法(exec),因为文件读写不需要走这层:Docker 用 volume 挂载工作区,
 * 宿主和容器看到的是同一份文件。少一层转发,少一处出错。
 *
 * local  —— 宿主机直跑。零依赖、快,但只有路径级隔离。默认。
 * docker —— 每个工作区一个容器,命令进容器执行。真隔离,代价是启动开销与镜像依赖。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { findShell } from './tools/bash.js';

export interface ExecResult { exit_code: number; stdout: string; stderr: string; error?: string }
export interface ExecOpts {
  timeoutMs?: number;
  cwd?: string;
  /** 往命令的 stdin 灌数据。传大内容必须走这条路 ——
   *  命令行参数在 Windows 上只有 32767 字符,拼进去会静默出错。 */
  stdin?: string;
  /** 输出截断上限。默认 16KB 是**给模型看**的尺度(省 token、防刷屏);
   *  内部用途(比如把文件 base64 读回来)必须放开,否则大文件会被悄悄砍半。 */
  maxOutput?: number;
}

export interface Executor {
  readonly kind: 'local' | 'docker';
  /** 描述当前执行环境,写进日志/报告便于复现 */
  readonly describe: string;
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  dispose(): Promise<void>;
}

const MAX_OUTPUT = 16_000;
const clip = (s: string, cap: number) => s.length > cap ? s.slice(0, cap) + `\n…(截断,共 ${s.length} 字符)` : s;

/** 裸 spawn 封装。所有执行器最终都落到这里,只是命令行不同。 */
function run(file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv, stdin?: string, maxOutput = MAX_OUTPUT): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = spawn(file, args, { env: env ?? process.env, windowsHide: true });
    if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    else child.stdin.end();
    let stdout = ''; let stderr = ''; let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { if (stdout.length < maxOutput) stdout += d.toString(); });
    child.stderr.on('data', d => { if (stderr.length < maxOutput) stderr += d.toString(); });
    child.on('error', err => { clearTimeout(timer); resolve({ exit_code: -1, stdout: '', stderr: '', error: String(err.message) }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        exit_code: killed ? 124 : code ?? 0,
        stdout: clip(stdout.trimEnd(), maxOutput), stderr: clip(stderr.trimEnd(), maxOutput),
        ...(killed ? { error: `超时 ${timeoutMs}ms 被杀` } : {}),
      });
    });
  });
}

export class LocalExecutor implements Executor {
  readonly kind = 'local' as const;
  readonly describe = '宿主机直跑(路径级隔离,非沙箱)';
  constructor(private root: string) {}

  async exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    const shell = findShell();
    if (!shell) return { exit_code: -1, stdout: '', stderr: '', error: '找不到可用的 bash(Windows 需装 Git Bash,或设 BASH_PATH)' };
    return run(shell, ['-c', `cd ${JSON.stringify(opts.cwd ?? this.root)} && ${cmd}`], opts.timeoutMs ?? 30_000, undefined, opts.stdin, opts.maxOutput);
  }
  async dispose() {}
}

/** Windows 路径转 Docker 挂载点:D:\a\b → /d/a/b(Docker Desktop 认这种写法) */
export function toMountPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

export interface DockerOpts { image?: string; memory?: string; cpus?: string; network?: 'none' | 'bridge' }

/** 容器常驻,命令走 docker exec。
 *  不用 `docker run` 一次一容器:那样每条命令都付一次启动开销,而且 cd/环境变量不跨命令保留。 */
export class DockerExecutor implements Executor {
  readonly kind = 'docker' as const;
  readonly describe: string;
  private container?: string;
  private starting?: Promise<void>;

  constructor(private root: string, private opts: DockerOpts = {}) {
    this.describe = `docker:${opts.image ?? DEFAULT_IMAGE}(network=${opts.network ?? 'none'})`;
  }

  private async ensure(): Promise<void> {
    if (this.container) return;
    this.starting ??= (async () => {
      const name = `my-agent-${randomUUID().slice(0, 8)}`;
      const args = [
        'run', '-d', '--rm', '--name', name,
        // 默认断网:评测要可复现,联网会把外部世界的抖动混进分数;需要装依赖时显式开 bridge
        '--network', this.opts.network ?? 'none',
        '--memory', this.opts.memory ?? '2g',
        '--cpus', this.opts.cpus ?? '2',
        '-v', `${toMountPath(this.root)}:/work`,
        '-w', '/work',
        this.opts.image ?? DEFAULT_IMAGE,
        'sleep', 'infinity',
      ];
      const r = await run('docker', args, 120_000);
      if (r.exit_code !== 0) throw new Error(`容器启动失败:${r.stderr || r.error || r.stdout}`);
      this.container = name;
    })();
    await this.starting;
  }

  async exec(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
    try { await this.ensure(); } catch (err: any) {
      return { exit_code: -1, stdout: '', stderr: '', error: String(err?.message ?? err) };
    }
    const workdir = opts.cwd ? toMountPath(opts.cwd).replace(toMountPath(this.root), '/work') : '/work';
    // -i 是给 stdin 用的:没有它 docker exec 不接管道,大文件就写不进去
    const dockerArgs = ['exec', ...(opts.stdin !== undefined ? ['-i'] : []), '-w', workdir, this.container!, 'bash', '-lc', cmd];
    return run('docker', dockerArgs, opts.timeoutMs ?? 30_000, undefined, opts.stdin, opts.maxOutput);
  }

  async dispose(): Promise<void> {
    if (!this.container) return;
    await run('docker', ['rm', '-f', this.container], 30_000).catch(() => {});
    this.container = undefined;
  }
}

export const DEFAULT_IMAGE = process.env.SANDBOX_IMAGE ?? 'python:3.12-slim';

/** docker daemon 通不通。CLI 装了不等于 daemon 起着 —— 本机就是这个状态。 */
export async function dockerAvailable(): Promise<{ ok: boolean; detail: string }> {
  const r = await run('docker', ['info', '--format', '{{.ServerVersion}}/{{.OSType}}'], 15_000);
  if (r.exit_code === 0 && r.stdout.trim()) return { ok: true, detail: r.stdout.trim() };
  const why = (r.stderr || r.error || '').split('\n')[0] ?? '未知';
  return { ok: false, detail: why.slice(0, 160) };
}

/** 按配置造执行器。SANDBOX=docker 且 daemon 可用才用 docker,否则退回 local 并说明原因。 */
export async function makeExecutor(root: string, want = process.env.SANDBOX ?? 'local'): Promise<Executor> {
  if (want !== 'docker') return new LocalExecutor(root);
  const probe = await dockerAvailable();
  if (!probe.ok) {
    console.warn(`[sandbox] 要求 docker 但不可用(${probe.detail}),退回 local`);
    return new LocalExecutor(root);
  }
  return new DockerExecutor(root, {
    image: process.env.SANDBOX_IMAGE,
    memory: process.env.SANDBOX_MEMORY,
    cpus: process.env.SANDBOX_CPUS,
    network: (process.env.SANDBOX_NETWORK as 'none' | 'bridge') ?? 'none',
  });
}
