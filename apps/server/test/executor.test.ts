/** 执行器:local 行为、docker 降级、Windows 挂载路径转换。
 *  docker 用例只在 daemon 可用时才真跑,否则跳过 —— CI 不该因为没装 Docker 就红。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalExecutor, DockerExecutor, makeExecutor, dockerAvailable, toMountPath } from '../src/executor.js';

test('local:在工作区里执行,拿得到 stdout 与 exit_code', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exec-'));
  try {
    await writeFile(path.join(dir, 'a.txt'), 'hello\nworld\n');
    const ex = new LocalExecutor(dir);
    assert.equal(ex.kind, 'local');

    const ls = await ex.exec('ls');
    assert.equal(ls.exit_code, 0);
    assert.match(ls.stdout, /a\.txt/);

    const wc = await ex.exec('wc -l < a.txt');
    assert.equal(wc.stdout.trim(), '2');

    const bad = await ex.exec('exit 3');
    assert.equal(bad.exit_code, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local:超时被杀,退出码 124', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exec-to-'));
  try {
    const r = await new LocalExecutor(dir).exec('sleep 10', { timeoutMs: 800 });
    assert.equal(r.exit_code, 124);
    assert.match(String(r.error), /超时/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('挂载路径:Windows 盘符转成 docker 认的形式', () => {
  assert.equal(toMountPath('D:\\Projects\\ws'), '/d/Projects/ws');
  assert.equal(toMountPath('C:/x/y'), '/c/x/y');
  assert.equal(toMountPath('/var/tmp/ws'), '/var/tmp/ws');   // POSIX 原样
});

test('要 docker 但不可用时退回 local,而不是报错', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exec-fb-'));
  try {
    const probe = await dockerAvailable();
    const ex = await makeExecutor(dir, 'docker');
    // daemon 在就该拿到 docker,不在就该拿到 local —— 两种都不能抛
    assert.equal(ex.kind, probe.ok ? 'docker' : 'local');
    await ex.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('docker:容器内执行且工作区可见(daemon 不可用则跳过)', async t => {
  const probe = await dockerAvailable();
  if (!probe.ok) return t.skip(`docker daemon 不可用:${probe.detail}`);

  const dir = await mkdtemp(path.join(tmpdir(), 'exec-dk-'));
  const ex = new DockerExecutor(dir, { image: 'python:3.12-slim' });
  try {
    await writeFile(path.join(dir, 'in.txt'), 'from-host\n');

    // 宿主写的文件容器里读得到(volume 挂载,不是拷贝)
    const cat = await ex.exec('cat in.txt');
    assert.equal(cat.stdout.trim(), 'from-host');

    // 容器里确实是 Linux,而不是悄悄回落到宿主机
    const uname = await ex.exec('uname -s');
    assert.equal(uname.stdout.trim(), 'Linux');

    // 容器写的文件宿主看得到
    await ex.exec('echo from-container > out.txt');
    const { readFile } = await import('node:fs/promises');
    assert.match(await readFile(path.join(dir, 'out.txt'), 'utf8'), /from-container/);
  } finally {
    await ex.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
