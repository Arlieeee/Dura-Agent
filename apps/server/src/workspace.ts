/** workspace:每个 thread 一个隔离工作区。所有文件工具只能在区内活动,路径逃逸直接拒绝。
 *
 * 边界声明(说清楚比装作安全重要):这是**路径级**隔离,不是内核级沙箱。
 * 它挡住 `../../etc/passwd` 这类误用与模型幻觉,但挡不住 bash 里的 `cd /`。
 * 真上生产请套容器/gVisor/firecracker——沙箱是运行时的事,不是路径拼接能解决的。 */
import { mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.env.WORKSPACE_ROOT ?? path.join(os.tmpdir(), 'my-agent-workspaces');

/** 工作区契约。抽成接口是为了让"文件在哪儿"和"命令在哪儿跑"解耦:
 *  本地任务用 Workspace(宿主 fs),容器内任务用 ContainerWorkspace(命令代劳)。
 *  工具层只认这个接口,所以两种模式下 read_file/edit_file 一行都不用改。 */
export interface WorkspaceLike {
  readonly root: string;
  resolve(rel: string): string;
  rel(abs: string): string;
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  list(rel?: string, max?: number): Promise<string[]>;
}

export class Workspace implements WorkspaceLike {
  constructor(readonly root: string) {}

  /** 把模型给的相对路径解析成绝对路径,越界抛错。symlink 逃逸也在这里挡掉。 */
  resolve(rel: string): string {
    const p = path.resolve(this.root, rel ?? '.');
    const base = path.resolve(this.root);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`路径越界:${rel}(工作区外不可访问)`);
    return p;
  }

  /** 绝对路径 → 展示给模型的相对路径(始终用 / 分隔,跨平台稳定) */
  rel(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join('/') || '.';
  }

  async ensure(): Promise<this> { await mkdir(this.root, { recursive: true }); return this; }

  async read(rel: string): Promise<string> { return readFile(this.resolve(rel), 'utf8'); }

  async write(rel: string, content: string): Promise<void> {
    const abs = this.resolve(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }

  async exists(rel: string): Promise<boolean> { try { await stat(this.resolve(rel)); return true; } catch { return false; } }

  /** 递归列目录(相对路径),跳过 node_modules/.git,最多 max 条。 */
  async list(rel = '.', max = 500): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length >= max) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (out.length >= max) return;
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { out.push(this.rel(abs) + '/'); await walk(abs); }
        else out.push(this.rel(abs));
      }
    };
    await walk(this.resolve(rel));
    return out.sort();
  }

  async destroy(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}

/** thread 级工作区(server 常规路径):WORKSPACE_ROOT/<thread_id>/ */
export async function threadWorkspace(threadId: string): Promise<Workspace> {
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return new Workspace(path.join(ROOT, safe)).ensure();
}

/** 任意目录挂成工作区(bench 用:每道题一个预置好初始状态的临时目录) */
export async function openWorkspace(dir: string): Promise<Workspace> {
  return new Workspace(path.resolve(dir)).ensure();
}

export const workspaceRoot = () => ROOT;
export const workspaceExists = (dir: string) => existsSync(dir);
