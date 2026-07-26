/** 技能白名单:frontmatter 解析、交集收窄、两层拦截。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSkill } from '../src/skills.js';
import { toolSpecs, runTool } from '../src/tools/index.js';
import { openWorkspace } from '../src/workspace.js';

test('frontmatter:解析 allowed-tools,正文不含 frontmatter', () => {
  const s = parseSkill('demo', '---\nallowed-tools: read_file, grep_files\n---\n# 正文\n干活');
  assert.deepEqual(s.allowedTools, ['read_file', 'grep_files']);
  assert.equal(s.body, '# 正文\n干活');
  assert.ok(!s.body.includes('allowed-tools'));
});

test('frontmatter:数组写法与引号都认;没有 frontmatter 则不设限', () => {
  assert.deepEqual(parseSkill('a', '---\nallowed-tools: ["bash", \'read_file\']\n---\nx').allowedTools,
    ['bash', 'read_file']);
  const plain = parseSkill('b', '# 就是一段说明');
  assert.equal(plain.allowedTools, undefined);
  assert.equal(plain.body, '# 就是一段说明');
});

test('白名单第一层:不在名单里的工具不上架', () => {
  const allow = new Set(['read_file', 'grep_files']);
  const names = toolSpecs('coding', { allow }).map(t => t.name).sort();
  assert.deepEqual(names, ['grep_files', 'read_file']);
  assert.ok(!names.includes('write_file'));
  // 不传 allow 就是不设限
  assert.ok(toolSpecs('coding').map(t => t.name).includes('write_file'));
});

test('白名单第二层:模型硬调没上架的工具,执行前被拒', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'skillguard-'));
  try {
    const ws = await openWorkspace(dir);
    await ws.write('a.txt', 'hello');
    const ctx = { workspace: ws, progress: () => {}, store: null as any, threadId: 't', turnId: 'r',
      allowedTools: new Set(['read_file']) };

    const ok = await runTool('read_file', { path: 'a.txt' }, ctx);
    assert.equal(ok.ok, true);

    // 名单外:即使工具真实存在也不给跑,且不能有副作用
    const denied = await runTool('write_file', { path: 'evil.txt', content: 'x' }, ctx);
    assert.equal(denied.ok, false);
    assert.match(String((denied.output as any).error), /不在当前技能允许的范围内/);
    assert.equal(await ws.exists('evil.txt'), false, '被拒的工具竟然产生了副作用');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
