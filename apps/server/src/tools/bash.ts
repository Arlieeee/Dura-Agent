/** bash:在工作区内跑 shell 命令。默认关闭(ENABLE_BASH=1 开启)。
 *
 * 安全边界(说清楚比装作安全重要):cwd 锁在工作区、有超时、有输出上限、有命令黑名单,
 * 但**这不是沙箱**——bash 本身能 `cd /`。开这个工具就等于把宿主机交给模型。
 * 正确姿势:容器里跑 server(本项目 Dockerfile 已就绪),或只在 bench 的一次性临时目录里开。 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolFn } from './index.js';
import { LocalExecutor } from '../executor.js';

const TIMEOUT_MS = Number(process.env.BASH_TIMEOUT_MS ?? 30_000);

/** 明确拒绝的破坏性/越权模式。黑名单永远不完备,它的作用是挡误伤而非防攻击。 */
const DENY = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/i,   // rm -rf 家族
  /\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b/i,
  /:\(\)\s*\{.*\}\s*;\s*:/,                    // fork bomb
  /\bcurl\b[^|]*\|\s*(ba)?sh\b|\bwget\b[^|]*\|\s*(ba)?sh\b/i,   // 管道执行远程脚本
];

/** 找一个能用的 POSIX shell。Windows 上 system32\bash.exe 是 WSL(路径语义不同),优先 Git Bash。 */
let cachedShell: string | null | undefined;
export function findShell(): string | null {
  if (cachedShell !== undefined) return cachedShell;
  if (process.env.BASH_PATH && existsSync(process.env.BASH_PATH)) return (cachedShell = process.env.BASH_PATH);
  if (process.platform !== 'win32') return (cachedShell = '/bin/bash');

  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const m = /^(.*)[\\/](cmd|bin|mingw64[\\/]bin)$/i.exec(dir);          // 从 git.exe 的目录反推安装根
    if (m && /git/i.test(dir)) candidates.push(path.join(m[1], 'bin', 'bash.exe'));
  }
  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'F:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  );
  return (cachedShell = candidates.find(existsSync) ?? null);
}

export const bashEnabled = () => process.env.ENABLE_BASH === '1' && !!findShell();

export const bashTool: ToolFn = async (args, ctx) => {
  if (process.env.ENABLE_BASH !== '1') throw new Error('bash 工具未启用(设 ENABLE_BASH=1)');
  const shell = findShell();
  if (!shell) throw new Error('找不到可用的 bash(Windows 需装 Git Bash,或设 BASH_PATH)');

  const cmd = String(args.command ?? '').trim();
  if (!cmd) throw new Error('command 不能为空');
  const hit = DENY.find(re => re.test(cmd));
  if (hit) throw new Error(`命令被安全策略拒绝(匹配 ${hit})。要删文件请用具体路径的 rm <file>。`);

  const where = ctx.executor?.kind ?? 'local';
  ctx.progress({ status: 'running', command: cmd.slice(0, 200), where });

  // 执行落到 Executor:local 在宿主机直跑,docker 进容器。
  // 注意黑名单在**这一层**照样生效 —— 容器里也不该让模型随手 rm -rf,
  // 出了事排查成本一样高,只是炸的不是宿主机而已。
  const exec = ctx.executor ?? new LocalExecutor(ctx.workspace.root);
  return exec.exec(cmd, { timeoutMs: TIMEOUT_MS });
};
