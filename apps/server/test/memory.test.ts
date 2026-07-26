/** 跨 session 记忆:两级结构、检索打分、索引自维护、路径防护。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryDir } from '../src/memory.js';
import { runTool } from '../src/tools/index.js';
import { openWorkspace } from '../src/workspace.js';

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mem-'));
  return { mem: await new MemoryDir(dir).ensure(), dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('写入 → 索引自动更新 → 正文可取回', async () => {
  const { mem, dir, cleanup } = await fixture();
  try {
    const r = await mem.write('部署约定', '这个项目怎么上线', '用 docker compose --profile prod,别手动 scp。');
    assert.equal(r.updated, false);
    assert.equal(r.file, '部署约定.md');

    const index = await readFile(path.join(dir, 'MEMORY.md'), 'utf8');
    assert.match(index, /部署约定/);
    assert.match(index, /这个项目怎么上线/);

    const rec = await mem.read('部署约定.md');
    assert.equal(rec?.description, '这个项目怎么上线');
    assert.match(rec!.body, /docker compose/);
  } finally { await cleanup(); }
});

test('索引只有标题+描述,不含正文(常驻提示词的成本前提)', async () => {
  const { mem, cleanup } = await fixture();
  try {
    await mem.write('长记忆', '一句话描述', 'X'.repeat(5000));
    const manifest = await mem.manifest();
    assert.match(manifest, /长记忆/);
    assert.ok(!manifest.includes('XXXX'), '索引里混进了正文');
    assert.ok(manifest.length < 200, `索引不该随正文膨胀,实际 ${manifest.length} 字符`);
  } finally { await cleanup(); }
});

test('检索:标题/描述命中的权重高于正文', async () => {
  const { mem, cleanup } = await fixture();
  try {
    await mem.write('postgres 连接串', '数据库配置在哪', '见 .env.local 的 DATABASE_URL');
    await mem.write('随手记', '无关的东西', '这里顺便提了一句 postgres,但主题不是它');
    const hits = await mem.search('postgres', 2);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].name, 'postgres 连接串', '标题命中的应当排在正文命中之前');
  } finally { await cleanup(); }
});

test('检索:没命中就返回空,不硬凑', async () => {
  const { mem, cleanup } = await fixture();
  try {
    await mem.write('部署约定', '上线流程', 'docker compose');
    assert.deepEqual(await mem.search('量子力学'), []);
  } finally { await cleanup(); }
});

test('同名写入是覆盖而非重复;索引不会长出两条', async () => {
  const { mem, cleanup } = await fixture();
  try {
    await mem.write('约定', 'v1', '旧内容');
    const second = await mem.write('约定', 'v2', '新内容');
    assert.equal(second.updated, true);
    const rec = await mem.read('约定.md');
    assert.match(rec!.body, /新内容/);
    assert.equal((await mem.scan()).filter(h => h.name === '约定').length, 1);
  } finally { await cleanup(); }
});

test('路径防护:两条入口都出不去记忆目录', async () => {
  const { mem, cleanup } = await fixture();
  try {
    // 入口一:以 .md 结尾的会被当成文件名直接 resolve —— 必须抛,不能静默当成"没找到"
    await assert.rejects(async () => { await mem.read('../../../etc/secret.md'); }, /越界/);

    // 入口二:不以 .md 结尾的先过 slugify,`../` 被洗成普通字符,落不到目录外
    assert.equal(await mem.read('../../../etc/passwd'), null);
    const r = await mem.write('../../evil', 'x', 'y');
    assert.ok(!r.file.includes('..'), `文件名没被规范化:${r.file}`);
    assert.equal(r.file, 'evil.md');
  } finally { await cleanup(); }
});

test('工具层:remember/recall 走一遍完整链路', async () => {
  const { mem, cleanup } = await fixture();
  const wsDir = await mkdtemp(path.join(tmpdir(), 'mem-ws-'));
  try {
    const ctx = { workspace: await openWorkspace(wsDir), progress: () => {}, store: null as any,
      threadId: 't', turnId: 'r', memory: mem };

    const w = await runTool('remember', { name: '用户偏好', description: '回复语言', body: '始终用中文回复' }, ctx);
    assert.equal(w.ok, true);

    const hit = await runTool('recall', { query: '语言' }, ctx);
    assert.equal(hit.ok, true);
    assert.equal((hit.output as any).found, 1);
    assert.match((hit.output as any).memories[0].content, /中文/);

    const miss = await runTool('recall', { query: '完全无关的词' }, ctx);
    assert.equal((miss.output as any).found, 0);
  } finally { await cleanup(); await rm(wsDir, { recursive: true, force: true }); }
});

test('未注入记忆目录时 remember/recall 不上架', async () => {
  const wsDir = await mkdtemp(path.join(tmpdir(), 'mem-off-'));
  try {
    const ctx = { workspace: await openWorkspace(wsDir), progress: () => {}, store: null as any, threadId: 't', turnId: 'r' };
    const r = await runTool('remember', { name: 'x', body: 'y' }, ctx);
    assert.equal(r.ok, false);
    assert.match(String((r.output as any).error), /未启用记忆/);
  } finally { await rm(wsDir, { recursive: true, force: true }); }
});
