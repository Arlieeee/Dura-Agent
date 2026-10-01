/** 容器内工作区:文件读写靠命令代劳,不经过宿主 fs。
 *
 * 为什么需要它:SWE-bench 这类评测的代码躺在官方镜像的 `/testbed` 里 —— 那是镜像自带的,
 * 不是挂载进去的,宿主机根本看不到。而工具层(read_file / edit_file / grep_files)
 * 全都直接读宿主 fs,所以在容器任务上一个都用不了。
 *
 * 实现上只做一件事:把 WorkspaceLike 的每个方法翻译成一条 shell 命令。
 * 因为工具层只认接口,`edit_file` 那套"精确替换 + 唯一性校验"的逻辑一行都不用改。
 *
 * 传内容一律走 base64。直接拼 `echo "..." > file` 会死在引号、反斜杠、换行和 UTF-8 上,
 * 而且模型写的代码里这些字符全都有。 */
import type { Executor } from './executor.js';
import type { WorkspaceLike } from './workspace.js';

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;      // 单引号包起来,内部单引号转义

export class ContainerWorkspace implements WorkspaceLike {
  /** root 必须是 **POSIX 绝对路径**(容器内一律如此,默认 /testbed)。
   *  传 Windows 路径会在归一化时把盘符当成普通目录段,进而误判越界 —— 所以直接拒掉,
   *  别让它在运行时以"路径越界"的面目出现。宿主路径请先过 executor 的 toMountPath()。 */
  constructor(private exec: Executor, readonly root: string = '/testbed') {
    if (!root.startsWith('/')) throw new Error(`ContainerWorkspace 的 root 必须是 POSIX 绝对路径,收到:${root}`);
  }

  /** 容器里一律 POSIX 路径。越界判断按前缀,规则与本地实现一致。 */
  resolve(rel: string): string {
    const clean = (rel ?? '.').replace(/\\/g, '/');
    const abs = clean.startsWith('/') ? clean : `${this.root}/${clean}`;
    const norm: string[] = [];
    for (const seg of abs.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') norm.pop();
      else norm.push(seg);
    }
    const out = '/' + norm.join('/');
    if (out !== this.root && !out.startsWith(this.root.replace(/\/$/, '') + '/')) {
      throw new Error(`路径越界:${rel}(工作区外不可访问)`);
    }
    return out;
  }

  rel(abs: string): string {
    const base = this.root.replace(/\/$/, '') + '/';
    return abs.startsWith(base) ? abs.slice(base.length) : abs;
  }

  async read(rel: string): Promise<string> {
    const p = this.resolve(rel);
    // base64 回传:文件里可能有任何字节,原样走 stdout 会被换行/编码搅乱
    // maxOutput 必须放开:默认 16KB 上限是给模型看的,套在这里会把 12KB 以上的文件读残
    // —— 而且是**静默**读残,exit_code 照样 0。
    // 走 stdin 而不是位置参数:BSD(macOS)的 base64 不认位置参数,GNU 的折行下面会剥掉
    const r = await this.exec.exec(`base64 < ${q(p)}`,
      { timeoutMs: 60_000, maxOutput: 8 << 20 });
    if (r.exit_code !== 0) throw new Error(`读取失败 ${rel}:${(r.stderr || r.error || '').slice(0, 160)}`);
    return Buffer.from(r.stdout.replace(/\s/g, ''), 'base64').toString('utf8');
  }

  async write(rel: string, content: string): Promise<void> {
    const p = this.resolve(rel);
    const dir = p.slice(0, p.lastIndexOf('/')) || '/';
    // 内容走 stdin,不进命令行。
    // 踩过的坑:先前把 base64 分块拼进命令行参数,12000 字符以上就开始悄悄丢数据 ——
    // 没有报错、exit_code 也是 0,只是文件内容不对。命令行传大数据这条路本身就是错的。
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const r = await this.exec.exec(`mkdir -p ${q(dir)} && base64 -d > ${q(p)}`, { timeoutMs: 60_000, stdin: b64 });
    if (r.exit_code !== 0) throw new Error(`写入失败 ${rel}:${(r.stderr || r.error || '').slice(0, 160)}`);
  }

  async exists(rel: string): Promise<boolean> {
    const r = await this.exec.exec(`test -e ${q(this.resolve(rel))}`, { timeoutMs: 15_000 });
    return r.exit_code === 0;
  }

  async list(rel = '.', max = 500): Promise<string[]> {
    const p = this.resolve(rel);
    // 不用 -printf:那是 GNU 独有,BSD(macOS)的 find 不认。目录靠尾部 / 区分
    const skip = `-not -path '*/node_modules/*' -not -path '*/.git/*'`
      + (p.includes('/.dura') ? '' : ` -not -path '*/.dura/*' -not -name .dura`);
    const r = await this.exec.exec(
      `{ find ${q(p)} ${skip} -type d | sed 's|$|/|'; find ${q(p)} ${skip} ! -type d; } 2>/dev/null | head -n ${max}`,
      { timeoutMs: 60_000 });
    if (r.exit_code !== 0) return [];
    return r.stdout.split('\n').filter(Boolean).map(line =>
      line.endsWith('/') ? `${this.rel(line.slice(0, -1))}/` : this.rel(line),
    ).filter(x => x && x !== './' && x !== '.').sort();
  }
}
