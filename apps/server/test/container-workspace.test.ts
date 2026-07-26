/** ContainerWorkspace:用 LocalExecutor 验证命令语义(与容器里同一套 shell 逻辑)。
 *  真容器上的验证在 executor.test.ts 里,daemon 不可用时自动跳过。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContainerWorkspace } from '../src/container-workspace.js';
import { LocalExecutor, toMountPath } from '../src/executor.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'cws-'));
  // ContainerWorkspace 只吃 POSIX 绝对路径(容器里本就如此)。本地跑测试要把
  // Windows 盘符转成 Git Bash 认的 /c/... 形式,否则归一化会把 "C:" 当成一个目录段。
  const posixDir = toMountPath(dir.replace(/\\/g, '/'));
  return {
    ws: new ContainerWorkspace(new LocalExecutor(posixDir), posixDir),
    dir, cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('root 必须是 POSIX 绝对路径,传 Windows 路径直接拒', () => {
  assert.throws(() => new ContainerWorkspace(new LocalExecutor('.'), 'D:\\x\\y'), /POSIX 绝对路径/);
  assert.doesNotThrow(() => new ContainerWorkspace(new LocalExecutor('.'), '/testbed'));
});

test('base64 往返:引号/反斜杠/中文/换行/制表符都不损坏', async () => {
  const { ws, cleanup } = await fixture();
  try {
    // 这些字符正是"直接拼 echo 写文件"会死掉的地方,而模型写的代码里它们全都有
    const tricky = [
      'line1',
      '  "double" \'single\' `backtick`',
      '中文 $VAR ${BRACE} \\backslash',
      'tab\there',
      'trailing   ',
    ].join('\n');
    await ws.write('a/b.txt', tricky);
    assert.equal(await ws.read('a/b.txt'), tricky);
  } finally { await cleanup(); }
});

test('大文件分块写入(超过单条命令长度上限)', async () => {
  const { ws, cleanup } = await fixture();
  try {
    const big = 'x'.repeat(200_000) + '\n结尾中文';
    await ws.write('big.txt', big);
    assert.equal(await ws.read('big.txt'), big);
  } finally { await cleanup(); }
});

test('exists / list', async () => {
  const { ws, cleanup } = await fixture();
  try {
    await ws.write('src/one.py', 'print(1)');
    await ws.write('src/two.py', 'print(2)');
    assert.equal(await ws.exists('src/one.py'), true);
    assert.equal(await ws.exists('nope.py'), false);

    const files = (await ws.list()).filter(f => !f.endsWith('/'));
    assert.deepEqual(files.sort(), ['src/one.py', 'src/two.py']);
  } finally { await cleanup(); }
});

test('路径解析:相对路径归一,越界抛错', async () => {
  const { ws, cleanup } = await fixture();
  try {
    assert.equal(ws.resolve('a/./b/../c.txt'), `${ws.root}/a/c.txt`);
    assert.throws(() => ws.resolve('../../etc/passwd'), /越界/);
    assert.throws(() => ws.resolve('/etc/passwd'), /越界/);
    assert.equal(ws.rel(`${ws.root}/x/y.txt`), 'x/y.txt');
  } finally { await cleanup(); }
});

test('读不存在的文件要抛,不能静默返回空串', async () => {
  const { ws, cleanup } = await fixture();
  try {
    await assert.rejects(ws.read('missing.txt'), /读取失败/);
  } finally { await cleanup(); }
});

test('接口兼容:文件工具不用改就能在容器工作区上跑', async () => {
  const { ws, cleanup } = await fixture();
  try {
    const { readFileTool, editFileTool, grepFilesTool } = await import('../src/tools/fs.js');
    const ctx = { workspace: ws, progress: () => {}, store: null as any, threadId: 't', turnId: 'r' };

    await ws.write('m.py', 'def f():\n    return 1\n');
    const r = await readFileTool({ path: 'm.py' }, ctx) as any;
    assert.match(r.content, /1\tdef f\(\)/);

    await editFileTool({ path: 'm.py', old_string: 'return 1', new_string: 'return 42' }, ctx);
    assert.match(await ws.read('m.py'), /return 42/);

    const g = await grepFilesTool({ pattern: 'return' }, ctx) as any;
    assert.equal(g.match_count, 1);
  } finally { await cleanup(); }
});
