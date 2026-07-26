/** 工具层单测:沙箱边界、edit 的唯一性契约、注册表分组。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace, openWorkspace } from '../src/workspace.js';
import { readFileTool, writeFileTool, editFileTool, listFilesTool, grepFilesTool } from '../src/tools/fs.js';
import { toolSpecs, isClientTool, runTool, activeTools } from '../src/tools/index.js';

async function fixture(): Promise<{ ws: Workspace; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'my-agent-test-'));
  const ws = await openWorkspace(dir);
  return { ws, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const ctx = (ws: Workspace) => ({ workspace: ws, progress: () => {}, store: null as any, threadId: 't', turnId: 'r' });

test('workspace:路径逃逸被拒绝(../ 与绝对路径)', async () => {
  const { ws, cleanup } = await fixture();
  try {
    assert.throws(() => ws.resolve('../outside.txt'), /路径越界/);
    assert.throws(() => ws.resolve('a/../../outside.txt'), /路径越界/);
    assert.throws(() => ws.resolve(process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd'), /路径越界/);
    assert.ok(ws.resolve('sub/ok.txt').startsWith(ws.root));   // 区内正常
  } finally { await cleanup(); }
});

test('write_file → read_file:round-trip,读取带行号', async () => {
  const { ws, cleanup } = await fixture();
  try {
    const w = await writeFileTool({ path: 'a/b.txt', content: 'l1\nl2\nl3' }, ctx(ws)) as any;
    assert.equal(w.created, true);
    const r = await readFileTool({ path: 'a/b.txt' }, ctx(ws)) as any;
    assert.equal(r.total_lines, 3);
    assert.equal(r.content, '1\tl1\n2\tl2\n3\tl3');

    const again = await writeFileTool({ path: 'a/b.txt', content: 'x' }, ctx(ws)) as any;
    assert.equal(again.created, false);                        // 覆盖时 created=false
  } finally { await cleanup(); }
});

test('read_file:offset/limit 分段读,truncated 提示剩余量', async () => {
  const { ws, cleanup } = await fixture();
  try {
    await ws.write('big.txt', Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = await readFileTool({ path: 'big.txt', offset: 2, limit: 3 }, ctx(ws)) as any;
    assert.equal(r.shown, '3-5');
    assert.equal(r.content, '3\tline3\n4\tline4\n5\tline5');
    assert.match(r.truncated, /还有 5 行/);
  } finally { await cleanup(); }
});

test('edit_file:唯一匹配才改;多匹配报错;replace_all 放行', async () => {
  const { ws, cleanup } = await fixture();
  try {
    await ws.write('c.ts', 'const a = 1;\nconst b = 1;\n');
    await assert.rejects(editFileTool({ path: 'c.ts', old_string: '= 1;', new_string: '= 2;' }, ctx(ws)), /匹配到 2 处/);
    assert.equal(await ws.read('c.ts'), 'const a = 1;\nconst b = 1;\n');   // 报错时文件未被动过

    const e = await editFileTool({ path: 'c.ts', old_string: 'const a = 1;', new_string: 'const a = 42;' }, ctx(ws)) as any;
    assert.equal(e.replaced, 1);
    assert.equal(await ws.read('c.ts'), 'const a = 42;\nconst b = 1;\n');

    const all = await editFileTool({ path: 'c.ts', old_string: 'const', new_string: 'let', replace_all: true }, ctx(ws)) as any;
    assert.equal(all.replaced, 2);
    assert.equal(await ws.read('c.ts'), 'let a = 42;\nlet b = 1;\n');
  } finally { await cleanup(); }
});

test('edit_file:未找到 old_string 时给出可操作的错误', async () => {
  const { ws, cleanup } = await fixture();
  try {
    await ws.write('d.txt', 'hello');
    await assert.rejects(editFileTool({ path: 'd.txt', old_string: 'nope', new_string: 'x' }, ctx(ws)), /未找到/);
  } finally { await cleanup(); }
});

test('list_files / grep_files:递归列举跳过 node_modules,grep 返回行号', async () => {
  const { ws, cleanup } = await fixture();
  try {
    await ws.write('src/one.ts', 'export const TARGET = 1;\nconst other = 2;');
    await ws.write('src/two.ts', 'import { TARGET } from "./one";');
    await mkdir(path.join(ws.root, 'node_modules', 'junk'), { recursive: true });
    await writeFile(path.join(ws.root, 'node_modules', 'junk', 'x.js'), 'TARGET');

    const l = await listFilesTool({}, ctx(ws)) as any;
    assert.deepEqual(l.files.filter((f: string) => !f.endsWith('/')).sort(), ['src/one.ts', 'src/two.ts']);

    const g = await grepFilesTool({ pattern: 'TARGET' }, ctx(ws)) as any;
    assert.equal(g.match_count, 2);
    assert.deepEqual(g.matches.map((m: any) => [m.path, m.line]).sort(), [['src/one.ts', 1], ['src/two.ts', 1]]);
  } finally { await cleanup(); }
});

test('注册表:分组切换换出不同工具面,ask_user 是唯一 client tool', () => {
  const chat = toolSpecs('chat').map(t => t.name);
  const coding = toolSpecs('coding').map(t => t.name);
  assert.deepEqual(chat.sort(), ['ask_user', 'web_search', 'write_document']);
  assert.ok(coding.includes('read_file') && coding.includes('edit_file') && coding.includes('grep_files'));
  assert.ok(!coding.includes('ask_user'));
  assert.ok(toolSpecs('full').length > chat.length);

  assert.equal(isClientTool('ask_user'), true);
  assert.equal(isClientTool('read_file'), false);
  assert.ok(activeTools('chat').every(t => typeof t.description === 'string' && t.description.length > 0));
});

test('注册表:bash 未开启时不出现在工具面(默认安全)', () => {
  const prev = process.env.ENABLE_BASH;
  delete process.env.ENABLE_BASH;
  try {
    assert.ok(!toolSpecs('coding').map(t => t.name).includes('bash'));
  } finally { if (prev !== undefined) process.env.ENABLE_BASH = prev; }
});

test('runTool:未知工具与工具抛错都收敛成 ok:false,不炸 turn', async () => {
  const { ws, cleanup } = await fixture();
  try {
    const unknown = await runTool('nope', {}, ctx(ws));
    assert.equal(unknown.ok, false);
    assert.match(String((unknown.output as any).error), /unknown tool/);

    const boom = await runTool('read_file', { path: 'missing.txt' }, ctx(ws));
    assert.equal(boom.ok, false);
    assert.ok((boom.output as any).error);
  } finally { await cleanup(); }
});
