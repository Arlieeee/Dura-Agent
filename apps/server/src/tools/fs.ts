/** 文件工具:read_file / write_file / edit_file / list_files / grep_files。
 * 设计对标 Pi/Claude Code 的经验结论:
 *  - read 带行号 → 模型能精确引用位置
 *  - edit 用 old_string/new_string **精确替换**而非 diff/行号 → 模型生成 diff 的错误率远高于抄一段原文
 *  - 唯一性校验:old_string 匹配到多处就报错要求加上下文,静默改错处比报错糟得多 */
import type { ToolFn } from './index.js';

const MAX_READ = 60_000;      // 单次读取上限(字符),超出截断并提示分段
const MAX_LINES = 2_000;

export const readFileTool: ToolFn = async (args, ctx) => {
  const p = String(args.path ?? '');
  ctx.progress({ status: 'reading', path: p });
  const src = await ctx.workspace.read(p);
  const all = src.split('\n');
  const offset = Math.max(0, Number(args.offset ?? 0));
  const limit = Math.min(Number(args.limit ?? MAX_LINES), MAX_LINES);
  const slice = all.slice(offset, offset + limit);
  const rawMode = args.raw === true;
  const body = rawMode
    ? slice.join('\n').slice(0, MAX_READ)
    : slice.map((l, i) => `${offset + i + 1}\t${l}`).join('\n').slice(0, MAX_READ);

  return {
    path: p, total_lines: all.length,
    shown: `${offset + 1}-${Math.min(offset + slice.length, all.length)}`,
    // 行号是**渲染出来的**,不在文件里。实测模型会把 "1\tALPHA" 整段抄进 write_file,
    // 于是行号进了产物 —— 所以每次都把这句话摆在它眼前,并给一个干净模式做退路。
    format: rawMode ? 'raw(无行号,原样内容)' : '每行前的「行号+Tab」是显示用的,不属于文件内容;要复制内容请去掉它,或用 raw=true 重读',
    content: body,
    truncated: offset + slice.length < all.length ? `还有 ${all.length - offset - slice.length} 行,用 offset 继续读` : undefined,
  };
};

export const writeFileTool: ToolFn = async (args, ctx) => {
  const p = String(args.path ?? '');
  const content = String(args.content ?? '');
  ctx.progress({ status: 'writing', path: p, bytes: content.length });
  const existed = await ctx.workspace.exists(p);
  await ctx.workspace.write(p, content);
  return { path: p, bytes: content.length, created: !existed };
};

export const editFileTool: ToolFn = async (args, ctx) => {
  const p = String(args.path ?? '');
  const oldStr = String(args.old_string ?? '');
  const newStr = String(args.new_string ?? '');
  const replaceAll = args.replace_all === true;
  if (!oldStr) throw new Error('old_string 不能为空(要新建文件请用 write_file)');
  ctx.progress({ status: 'editing', path: p });

  const src = await ctx.workspace.read(p);
  const hits = src.split(oldStr).length - 1;
  if (hits === 0) throw new Error(`old_string 在 ${p} 中未找到。先 read_file 确认原文(注意缩进与空白)。`);
  if (hits > 1 && !replaceAll) throw new Error(`old_string 在 ${p} 中匹配到 ${hits} 处。加上下文让它唯一,或传 replace_all=true。`);

  const out = replaceAll ? src.split(oldStr).join(newStr) : src.replace(oldStr, newStr);
  await ctx.workspace.write(p, out);
  return { path: p, replaced: replaceAll ? hits : 1, bytes: out.length };
};

export const listFilesTool: ToolFn = async (args, ctx) => {
  const dir = String(args.path ?? '.');
  ctx.progress({ status: 'listing', path: dir });
  const files = await ctx.workspace.list(dir);
  return { path: dir, count: files.length, files: files.slice(0, 300) };
};

export const grepFilesTool: ToolFn = async (args, ctx) => {
  const pattern = String(args.pattern ?? '');
  const glob = String(args.path ?? '.');
  if (!pattern) throw new Error('pattern 不能为空');
  ctx.progress({ status: 'grepping', pattern });
  let re: RegExp;
  try { re = new RegExp(pattern, 'g'); } catch (e: any) { throw new Error(`正则无效:${e.message}`); }

  // path 可以是目录也可以是文件。只按目录列的话,传文件会悄悄返回 0 条匹配 —— 模型偏偏常这么传
  let files = await ctx.workspace.list(glob);
  if (!files.length && await ctx.workspace.exists(glob)) files = [glob];
  const matches: { path: string; line: number; text: string }[] = [];
  for (const f of files) {
    if (f.endsWith('/') || matches.length >= 100) continue;
    let content: string;
    try { content = await ctx.workspace.read(f); } catch { continue; }
    if (content.includes('\0')) continue;                       // 二进制跳过
    content.split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      if (matches.length < 100 && re.test(line)) matches.push({ path: f, line: i + 1, text: line.trim().slice(0, 200) });
    });
  }
  return { pattern, match_count: matches.length, matches };
};
