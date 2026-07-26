/** 跨 session 持久记忆。Hermes 五层架构里的 Memory 层,也是 DeerFlow / Claude Code 都有而本项目一直缺的那块。
 *
 * 结构抄的是被验证过的两级形态(Claude Code 的 memdir、Hermes 的 SKILL.md 同源):
 *
 *   memory/
 *     MEMORY.md      索引:一行一条,常驻 system prompt
 *     <slug>.md      单条记忆:frontmatter 里 name/description/type,正文按需加载
 *
 * 两级的意义在于**成本**:索引很小可以常驻,正文再多也不占上下文,直到 recall 把它取出来。
 * 一股脑全塞进 system prompt 的做法,记忆越多、agent 越笨。
 *
 * 检索用词重叠打分而不是再调一次 LLM(Claude Code 用小模型 side query 选)。
 * 理由是评测:LLM 选择器会把"记忆有没有用"和"选择器准不准"两件事搅在一起,
 * 而且每次 recall 都要多花一次调用。确定性打分虽然笨,但可单测、零成本、结果可复现。 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_ROOT = process.env.MEMORY_ROOT ?? path.join(os.tmpdir(), 'my-agent-memory');
const MAX_FILES = 200;
const FRONTMATTER_LINES = 30;
/** 记忆正文全量注入的预算(字符)。超了才退回检索。 */
const BUDGET = Number(process.env.MEMORY_INJECT_BUDGET ?? 4000);

export interface MemoryHeader { name: string; file: string; description: string; type: string; mtimeMs: number }
export interface MemoryRecord extends MemoryHeader { body: string }

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';

/** 只解析 `--- key: value ---` 这一层,不引 YAML 依赖 */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n').slice(0, FRONTMATTER_LINES)) {
    const kv = /^\s*([\w-]+)\s*:\s*(.*)\s*$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { meta, body: m[2].trim() };
}

export class MemoryDir {
  constructor(readonly root: string = DEFAULT_ROOT) {}

  private resolve(file: string): string {
    const p = path.resolve(this.root, file);
    const base = path.resolve(this.root);
    if (p !== base && !p.startsWith(base + path.sep)) throw new Error(`记忆路径越界:${file}`);
    return p;
  }

  async ensure(): Promise<this> { await mkdir(this.root, { recursive: true }); return this; }

  /** 扫描 header:每个文件只读前 30 行拿 frontmatter,不读正文 */
  async scan(): Promise<MemoryHeader[]> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch { return []; }
    const files = entries.filter(f => f.endsWith('.md') && f !== 'MEMORY.md').slice(0, MAX_FILES);

    const headers = await Promise.all(files.map(async f => {
      try {
        const abs = this.resolve(f);
        const raw = (await readFile(abs, 'utf8')).split('\n').slice(0, FRONTMATTER_LINES).join('\n');
        const { meta } = parseFrontmatter(raw + '\n---\n');    // 补个尾以便只取到 frontmatter
        const { mtimeMs } = await stat(abs);
        return { name: meta.name || f.replace(/\.md$/, ''), file: f, description: meta.description ?? '', type: meta.type ?? 'note', mtimeMs };
      } catch { return null; }
    }));
    return headers.filter((h): h is MemoryHeader => h !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  /** 索引:常驻 system prompt 的那一小段 */
  async manifest(): Promise<string> {
    const hs = await this.scan();
    if (!hs.length) return '';
    return hs.map(h => `- ${h.name}:${h.description || '(无描述)'}`).join('\n');
  }

  /** 开局注入的记忆上下文:索引 + **对本次输入自动预取的正文**。
   *
   * 只给索引是不够的。实测:session A 里模型主动 remember 了"缩进用 2 空格",
   * session B 的提示词里索引条目也在,但模型既没 recall 也没照做 —— 它不会为了
   * 一条看起来不相关的索引专门去查。Claude Code 的 findRelevantMemories 是直接把
   * top-5 正文喂进去的,这一步不能指望模型自觉。
   *
   * 我们用词重叠代替它的小模型选择器:命中就把正文一起给,没命中就只给索引。 */
  async contextFor(query: string, budget = BUDGET): Promise<string> {
    const index = await this.manifest();
    if (!index) return '';

    // 记忆总量在预算内 → 全给。
    // 词重叠检索在这里是够不着的:用户说"写个 hello.py",记忆叫"python-indent-2-spaces",
    // 字面一个都不重合,但它显然该生效 —— 这种关联要语义理解才判得出来。
    // 实测过两轮:只给索引模型不会主动 recall;按词重叠预取则根本命中不了。
    // 所以小规模直接全量注入,大到装不下时才退回检索(那时漏召回也好过爆上下文)。
    const all: MemoryRecord[] = [];
    let total = 0;
    for (const h of await this.scan()) {
      const rec = await this.read(h.file);
      if (!rec) continue;
      all.push(rec);
      total += rec.body.length;
    }
    if (!all.length) return '';

    const picked = total <= budget ? all : await this.search(query, 2);
    if (!picked.length) return `【长期记忆】(要正文用 recall 取)\n${index}`;

    const bodies = picked.map(m => `### ${m.name}\n${m.body.slice(0, 1200)}`).join('\n\n');
    const head = total <= budget
      ? '【长期记忆(以下约定长期有效,做事时直接遵守)】'
      : `【长期记忆索引】(要正文用 recall 取)\n${index}\n\n【与本次输入相关的记忆】`;
    return `${head}\n${bodies}`;
  }

  async write(name: string, description: string, body: string, type = 'note'): Promise<{ file: string; updated: boolean }> {
    await this.ensure();
    const file = `${slugify(name)}.md`;
    const abs = this.resolve(file);
    const updated = await stat(abs).then(() => true).catch(() => false);
    const doc = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\ntype: ${type}\n---\n\n${body.trim()}\n`;
    await writeFile(abs, doc, 'utf8');
    await this.rebuildIndex();
    return { file, updated };
  }

  async read(file: string): Promise<MemoryRecord | null> {
    // resolve 放在 try 外面:越界要抛出去。把它和"文件不存在"一起吞成 null,
    // 调用方会以为只是没这条记忆,而实际上有人在试着读记忆目录外的东西。
    const abs = this.resolve(file.endsWith('.md') ? file : `${slugify(file)}.md`);
    try {
      const raw = await readFile(abs, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      const { mtimeMs } = await stat(abs);
      return { name: meta.name || file, file, description: meta.description ?? '', type: meta.type ?? 'note', mtimeMs, body };
    } catch { return null; }
  }

  /** 词重叠打分。名字与描述的权重高于正文 —— 它们本来就是写给检索看的。 */
  async search(query: string, limit = 3): Promise<MemoryRecord[]> {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const scored: { rec: MemoryRecord; score: number }[] = [];

    for (const h of await this.scan()) {
      const rec = await this.read(h.file);
      if (!rec) continue;
      const head = tokenize(`${rec.name} ${rec.description}`);
      const bodyTerms = tokenize(rec.body);
      let score = 0;
      for (const t of terms) {
        if (head.includes(t)) score += 3;
        else if (bodyTerms.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ rec, score });
    }
    return scored.sort((a, b) => b.score - a.score || b.rec.mtimeMs - a.rec.mtimeMs)
      .slice(0, limit).map(s => s.rec);
  }

  /** 索引由文件现推,不做增量维护 —— 增量迟早和真相对不上 */
  async rebuildIndex(): Promise<void> {
    const hs = await this.scan();
    const body = hs.length
      ? hs.map(h => `- [${h.name}](${h.file}) — ${h.description || '(无描述)'}`).join('\n')
      : '(暂无记忆)';
    await writeFile(this.resolve('MEMORY.md'), `# 记忆索引\n\n${body}\n`, 'utf8');
  }
}

/** 中英混排的粗分词:英文按词、中文按二元组。够用于"名字/描述里提到过没有"这种判断。 */
function tokenize(s: string): string[] {
  const lower = s.toLowerCase();
  const latin = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjk = lower.match(/[一-龥]+/g) ?? [];
  const bigrams: string[] = [];
  for (const run of cjk) {
    if (run.length === 1) bigrams.push(run);
    for (let i = 0; i + 1 < run.length; i++) bigrams.push(run.slice(i, i + 2));
  }
  return [...new Set([...latin, ...bigrams])];
}

export const memoryRoot = () => DEFAULT_ROOT;
