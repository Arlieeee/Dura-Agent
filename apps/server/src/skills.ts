/** skills:markdown 技能文件,注入 system prompt。
 *
 * 支持 YAML frontmatter 里的 `allowed-tools`(DeerFlow 的做法):
 * 技能生效时把工具面收窄到白名单。这是**安全**维度而不是提示词维度 ——
 * 一个"写周报"的技能没有任何理由能调 bash,靠提示词说"请不要"是拦不住的。
 *
 * 收窄是求交集:多个技能同时生效时,谁都没列的工具一律不给。 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export interface Skill {
  name: string;
  body: string;
  /** 该技能允许使用的工具;未声明 = 不设限 */
  allowedTools?: string[];
}

let cache: Skill[] | null = null;

/** 极简 frontmatter 解析:只认 `--- ... ---` 里的 `key: a, b, c`。不引 YAML 依赖。 */
export function parseSkill(name: string, raw: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { name, body: raw.trim() };

  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([\w-]+)\s*:\s*(.*)\s*$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
  }
  const list = meta['allowed-tools'];
  return {
    name, body: m[2].trim(),
    allowedTools: list
      ? list.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : undefined,
  };
}

export async function loadSkillDefs(): Promise<Skill[]> {
  if (cache !== null) return cache;
  try {
    const files = (await readdir(SKILLS_DIR)).filter(f => f.endsWith('.md'));
    const out: Skill[] = [];
    for (const f of files) out.push(parseSkill(f.replace(/\.md$/, ''), (await readFile(join(SKILLS_DIR, f), 'utf8')).slice(0, 4000)));
    cache = out;
  } catch { cache = []; }
  return cache;
}

export async function loadSkills(): Promise<string> {
  return (await loadSkillDefs()).map(s => s.body).join('\n---\n');
}

/** 生效技能对工具面的收窄结果;没有技能声明 allowed-tools 时返回 null(不设限)。
 *
 * `available` 是当前场景本来就有的工具名。只有**与当前场景沾边**的技能才参与收窄 ——
 * 一个只声明了 web_search/write_document 的写作技能,不该把 coding 场景的文件工具全掐掉。
 * (DeerFlow 是"技能激活后才限定";本项目还没有激活机制,技能文件常驻注入,
 *  所以用"声明的工具与当前工具集有交集"来近似判断它是否适用于此场景。) */
export async function skillToolAllowList(available?: Iterable<string>): Promise<Set<string> | null> {
  const pool = available ? new Set(available) : null;
  const declared = (await loadSkillDefs()).filter(s =>
    s.allowedTools?.length && (!pool || s.allowedTools.some(t => pool.has(t))));
  if (!declared.length) return null;
  // 求交集:一个技能没列的工具,别的技能列了也不放行
  let acc: Set<string> | undefined;
  for (const s of declared) {
    const cur = new Set<string>(s.allowedTools!);
    acc = acc ? new Set<string>([...acc].filter(t => cur.has(t))) : cur;
  }
  return acc ?? null;
}

export async function listSkills(): Promise<{ name: string; allowedTools?: string[] }[]> {
  return (await loadSkillDefs()).map(s => ({ name: s.name, allowedTools: s.allowedTools }));
}

/** 测试用:清掉缓存 */
export const resetSkillCache = () => { cache = null; };
