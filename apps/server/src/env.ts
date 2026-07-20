/** 零依赖 .env 加载:向上搜索 .env.local / .env(不覆盖已有环境变量)。 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadLocalEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [process.cwd(), join(here, '..'), join(here, '../../..'), join(here, '../../../..')]; // cwd → server → 仓库根(兼容 monorepo 上层)
  const seen = new Set<string>();
  for (const root of roots) {
    for (const name of ['.env.local', '.env']) {
      const p = join(root, name);
      if (seen.has(p) || !existsSync(p)) continue;
      seen.add(p);
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m || line.trim().startsWith('#')) continue;
        const key = m[1]; const val = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '');
        if (!(key in process.env)) process.env[key] = val;
      }
      console.log(`[env] 已加载 ${p}`);
    }
  }
}
