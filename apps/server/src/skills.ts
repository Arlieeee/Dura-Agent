/** skills:markdown 技能文件,注入 system prompt(MVP 版;进阶可做按需加载/用户订阅)。 */
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
let cache: string | null = null;

export async function loadSkills(): Promise<string> {
  if (cache !== null) return cache;
  try {
    const files = (await readdir(SKILLS_DIR)).filter(f => f.endsWith('.md'));
    const parts: string[] = [];
    for (const f of files) parts.push((await readFile(join(SKILLS_DIR, f), 'utf8')).slice(0, 2000));
    cache = parts.join('\n---\n');
  } catch { cache = ''; }
  return cache;
}

export async function listSkills(): Promise<{ name: string }[]> {
  try { return (await readdir(SKILLS_DIR)).filter(f => f.endsWith('.md')).map(name => ({ name })); }
  catch { return []; }
}
