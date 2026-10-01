/** 工具结果进上下文的样子。纯函数:runner 决定溢出、fold 渲染,两边共用,
 *  同一条事件永远渲染成同一段文本 —— 只追加的请求布局靠它保持前缀稳定。 */

/** 单条工具结果在上下文里最多占多少字符(约 1–1.5k token)。 */
export const INLINE_LIMIT = 4000;

/** 超出预算就要溢出到文件:原先在这里被直接截断,模型看不到后半截,也不知道被截了。 */
export const needsSpill = (output: unknown) => JSON.stringify(output ?? null).length > INLINE_LIMIT;

/** 落盘与预览用的可读文本:多行字符串原样展开、数组一项一行 —— read_file 与 grep_files 都按行工作。 */
export function formatToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object') return JSON.stringify(output ?? null);
  if (Array.isArray(output)) return output.map(x => JSON.stringify(x)).join('\n');
  return Object.entries(output).map(([k, v]) =>
    typeof v === 'string' && v.includes('\n') ? `[${k}]\n${v}`
      : Array.isArray(v) ? `[${k}]\n${v.map(x => JSON.stringify(x)).join('\n')}`
        : `[${k}] ${JSON.stringify(v)}`).join('\n');
}

/** 上下文里的那一段。没溢出的保持原样 JSON(小结果本就在预算内,旧事件的渲染也不变);
 *  溢出了的给头尾各一半,中间一行说清省了多少、全文在哪、怎么查 —— 结论常在尾部(测试汇总、最后一条报错)。 */
export function inlineToolOutput(output: unknown, spilledTo?: string): string {
  if (!spilledTo) return JSON.stringify(output ?? null).slice(0, INLINE_LIMIT);
  const text = formatToolOutput(output);
  if (text.length <= INLINE_LIMIT) return text;
  const half = INLINE_LIMIT / 2;
  return `${text.slice(0, half)}\n\n…(中间省略 ${text.length - 2 * half} 字符。完整结果在 ${spilledTo}:`
    + `用 read_file 的 offset/limit 分段读,或 grep_files(path=${spilledTo})搜索)…\n\n${text.slice(-half)}`;
}
