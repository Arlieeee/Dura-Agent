/** gateway:HTTP API + SSE + 轻量账号。路由按资源组织(/threads/:id/turns、/continue、/sse)。 */
import { loadLocalEnv } from './env.js';
loadLocalEnv();
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type { Chunk } from '../../../packages/protocol/src/index.js';
import { makeStore, eventId } from './store.js';
import { makeProvider } from './llm/provider.js';
import { makeDispatcher } from './queue.js';
import { fold, activeTurnId } from './engine/fold.js';
import { newThreadId, newTurnId, cancelTurn } from './engine/runner.js';
import { bus } from './bus.js';
import { listSkills } from './skills.js';
import { hashPass, verifyPass, signToken, verifyToken } from './auth.js';

const store = await makeStore();
const provider = makeProvider();
const dispatcher = await makeDispatcher({ store, provider });
const app = Fastify({ logger: false });

/* ---------- CORS:CORS_ORIGIN=逗号分隔域名;不设 = 全放开(仅限开发) ---------- */
const ORIGINS = (process.env.CORS_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean);
await app.register(cors, { origin: ORIGINS.length ? ORIGINS : true });
const sseOrigin = (req: any) => {
  if (!ORIGINS.length) return '*';
  const o = String(req.headers?.origin ?? '');
  return ORIGINS.includes(o) ? o : ORIGINS[0];
};

/* ---------- 内存滑窗限流(多实例部署时为每实例配额;0 = 关闭) ---------- */
function makeLimiter(limit: number, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  const t = setInterval(() => {
    const cut = Date.now() - windowMs;
    for (const [k, arr] of hits) { const v = arr.filter(x => x > cut); v.length ? hits.set(k, v) : hits.delete(k); }
  }, windowMs);
  (t as any).unref?.();
  return (key: string) => {
    if (limit <= 0) return true;
    const cut = Date.now() - windowMs;
    const arr = (hits.get(key) ?? []).filter(x => x > cut);
    if (arr.length >= limit) { hits.set(key, arr); return false; }
    arr.push(Date.now()); hits.set(key, arr); return true;
  };
}
const loginLimit = makeLimiter(Number(process.env.RATE_LOGIN_PER_MIN ?? 30));
const turnLimit = makeLimiter(Number(process.env.RATE_TURNS_PER_MIN ?? 10));

/* ---------- 请求日志(SSE 劫持的响应不经过此钩子) ---------- */
app.addHook('onResponse', async (req: any, reply: any) => {
  if (!String(req.url).startsWith('/api/')) return;
  console.log(`[http] ${req.method} ${String(req.url).split('?')[0]} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms${req.userId ? ` ${req.userId}` : ''}`);
});

/* ---------- 鉴权守卫:除 /api/auth/* 与 GET /api/artifacts/* 外一律要求 Bearer token ---------- */
app.addHook('preHandler', async (req: any, reply: any) => {
  const url = String(req.url).split('?')[0];
  if (!url.startsWith('/api/')) return;
  if (url.startsWith('/api/auth/')) return;
  if (req.method === 'GET' && url.startsWith('/api/artifacts/')) return;   // 文档链接可分享
  const userId = verifyToken(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (!userId || !(await store.getUser(userId))) return reply.code(401).send({ error: 'unauthorized' });
  req.userId = userId;
});
/** thread 归属校验:不是你的 thread 一律 404(不泄露存在性) */
async function ownThread(req: any, reply: any): Promise<boolean> {
  const t = await store.getThread(req.params.id);
  if (!t || t.user_id !== req.userId) { reply.code(404).send({ error: 'not found' }); return false; }
  return true;
}

/* ---------- auth ---------- */
app.post('/api/auth/login', async (req: any, reply: any) => {
  const username = String(req.body?.username ?? '').trim().slice(0, 32);
  if (!loginLimit(`${req.ip}|${username}`)) return reply.code(429).send({ error: '尝试过于频繁,请稍后再试' });
  const password = String(req.body?.password ?? '');
  if (!/^[\w一-龥-]{2,32}$/.test(username) || password.length < 4)
    return reply.code(400).send({ error: '用户名 2-32 字符,密码至少 4 位' });
  let u = await store.getUserByName(username);
  if (!u) {
    u = { id: 'usr_' + randomUUID().slice(0, 8), username, pass_hash: hashPass(password), created_at: new Date().toISOString() };
    await store.createUser(u);
    console.log(`[auth] 新用户注册: ${username}`);
  } else {
    const v = verifyPass(password, u.pass_hash);
    if (!v) return reply.code(401).send({ error: '密码错误' });
    if (v === 'upgrade') {                                  // 旧 sha256 哈希 → 登录成功时平滑升级为 scrypt
      await store.updateUserPassHash(u.id, hashPass(password));
      console.log(`[auth] 口令哈希已升级: ${username}`);
    }
  }
  return { token: signToken(u.id), user: { id: u.id, username: u.username } };
});
app.get('/api/me', async (req: any) => {
  const u = await store.getUser(req.userId);
  return { id: u!.id, username: u!.username };
});

/* ---------- SSE 帮手 ---------- */
function sse(req: any, reply: any) {
  reply.hijack();   // 接管后 @fastify/cors 不再生效,CORS 头必须手写(按白名单回显)
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    'access-control-allow-origin': sseOrigin(req),
  });
  const send = (c: Chunk) => reply.raw.write(`data: ${JSON.stringify(c)}\n\n`);
  return { send, close: () => reply.raw.end() };
}
function pipeUntilFinish(req: any, reply: any, threadId: string, first?: Chunk[]) {
  const { send, close } = sse(req, reply);
  (first ?? []).forEach(send);
  const off = bus.subscribe(threadId, c => {
    send(c);
    if (c.type === 'finish') { off(); close(); }
  });
  reply.raw.on('close', off);   // 客户端断开只取消订阅,不取消 turn
}

/* ---------- threads ---------- */
app.post('/api/threads', async (req: any) => {
  const id = newThreadId();
  await store.createThread(id, '新会话', req.userId);
  return { id };
});
app.get('/api/threads', async (req: any) => store.listThreads(req.userId));
app.get('/api/threads/:id', async (req: any, reply: any) => {
  if (!await ownThread(req, reply)) return;
  const events = await store.load(req.params.id);
  const artifacts = await store.listArtifacts(req.params.id);
  return { events, artifacts };
});

/* ---------- 核心:提交 turn(响应即 SSE 流) ---------- */
/** 正在受理中的 thread。has + add 之间没有 await,所以同一 thread 的并发提交只有一个能进门。 */
const admitting = new Set<string>();

app.post('/api/threads/:id/turns', async (req: any, reply: any) => {
  if (!await ownThread(req, reply)) return;
  if (!turnLimit(req.userId)) return reply.code(429).send({ error: '请求过于频繁,请稍后再试' });
  const threadId = req.params.id;
  const text = String(req.body?.text ?? '').slice(0, 4000);
  if (!text) return reply.code(400).send({ error: 'text required' });
  const turnId = newTurnId();

  // 准入门禁:一个 thread 同时只有一个未收尾的 turn。前端会禁用输入框,但 API 不能指望前端 ——
  // 两个 turn 交错写同一个 thread,user 消息会插进 tool_call 和 tool_result 之间,下一次请求直接 400
  if (admitting.has(threadId)) return reply.code(409).send({ error: '上一轮还没结束' });
  admitting.add(threadId);
  try {
    const active = activeTurnId(await store.load(threadId));
    if (active) return reply.code(409).send({ error: '上一轮还没结束', turn_id: active });
    await store.upsertTurn({ id: turnId, thread_id: threadId, state: 'pending', heartbeat_at: Date.now() });
    await store.append({ id: eventId(turnId, 'turn.started', 'start'), thread_id: threadId, turn_id: turnId, kind: 'turn.started', payload: { text } });
    await store.append({ id: eventId(turnId, 'user.message', 'msg'), thread_id: threadId, turn_id: turnId, kind: 'user.message', payload: { text } });
  } finally {
    admitting.delete(threadId);
  }
  const t = await store.getThread(threadId);
  if (t && (!t.title || t.title === '新会话')) await store.setThreadTitle(threadId, text.slice(0, 24));
  await store.touchThread(threadId);

  pipeUntilFinish(req, reply, threadId, [{ type: 'start', thread_id: threadId, turn_id: turnId }]);
  await dispatcher.kick(threadId, turnId).catch((e: any) => {   // hijack 后异常不会自动回给客户端,必须转成 finish chunk
    console.error('[gateway] kick 失败:', e?.message ?? e);
    bus.emit(threadId, { type: 'finish', finish_reason: 'error' });
  });
});

/* ---------- client tool 答复(ask_user)→ 追加事件 + 重投 ---------- */
app.post('/api/threads/:id/continue', async (req: any, reply: any) => {
  if (!await ownThread(req, reply)) return;
  const threadId = req.params.id;
  const { turn_id, tool_call_id, answer } = req.body ?? {};
  if (!turn_id || !tool_call_id) return reply.code(400).send({ error: 'turn_id & tool_call_id required' });
  if (!turnLimit(req.userId)) return reply.code(429).send({ error: '请求过于频繁,请稍后再试' });

  // 只接受「该 turn 正挂起等待这个 tool_call」的答复;重放/伪造一律不追加、不重跑,直接回终态流
  const st = fold(await store.load(threadId), String(turn_id));
  if (st.suspended?.tool_call_id !== tool_call_id) {
    const { send, close } = sse(req, reply);
    send({ type: 'start', thread_id: threadId, turn_id });
    send({ type: 'finish', finish_reason: st.status === 'suspended' ? 'tool-calls' : 'stop' });
    return close();
  }

  await store.append({
    id: eventId(turn_id, 'user.confirmation', tool_call_id),
    thread_id: threadId, turn_id, kind: 'user.confirmation',
    payload: { tool_call_id, answer: String(answer ?? '') },
  });
  await store.upsertTurn({ id: turn_id, thread_id: threadId, state: 'pending', heartbeat_at: Date.now() });
  await store.touchThread(threadId);

  pipeUntilFinish(req, reply, threadId, [{ type: 'start', thread_id: threadId, turn_id }]);
  await dispatcher.kick(threadId, turn_id).catch((e: any) => {
    console.error('[gateway] kick 失败:', e?.message ?? e);
    bus.emit(threadId, { type: 'finish', finish_reason: 'error' });
  });
});

/* ---------- 喊停当前 turn ---------- */
app.post('/api/threads/:id/cancel', async (req: any, reply: any) => {
  if (!await ownThread(req, reply)) return;
  const threadId = req.params.id;
  const turnId = activeTurnId(await store.load(threadId));
  if (!turnId) return { cancelled: null };
  await cancelTurn(store, threadId, turnId);
  // 在跑的 turn 已被 abort 打断;pending / suspended 的没有 runner,kick 一次让它收敛到 cancelled
  await dispatcher.kick(threadId, turnId);
  return { cancelled: turnId };
});

/* ---------- 断线重连 ---------- */
app.get('/api/threads/:id/sse', async (req: any, reply: any) => {
  if (!await ownThread(req, reply)) return;
  pipeUntilFinish(req, reply, req.params.id);
});

/* ---------- artifacts / skills / debug ---------- */
app.get('/api/artifacts/:id', async (req: any, reply: any) => {
  const a = await store.getArtifact(req.params.id);
  if (!a) return reply.code(404).send({ error: 'not found' });
  reply.header('content-type', 'text/markdown; charset=utf-8');
  return a.content;
});
app.get('/api/skills', async () => listSkills());
app.get('/api/threads/:id/state', async (req: any, reply: any) => {
  if (!await ownThread(req, reply)) return;
  const events = await store.load(req.params.id);
  const lastTurn = [...events].reverse().find(e => e.turn_id)?.turn_id ?? '';
  return fold(events, String(req.query?.turn_id ?? lastTurn));
});

/* ---------- 健康检查(容器/负载均衡探针) ---------- */
app.get('/healthz', async () => ({
  ok: true,
  store: process.env.DATABASE_URL ? 'postgres' : 'memory',
  runner: process.env.RUNNER_MODE ?? 'inline',
  provider: provider.name,
  uptime_s: Math.round(process.uptime()),
}));

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: '0.0.0.0' });
console.log(`[gateway] http://localhost:${port}`);

/* ---------- 启动恢复:重投崩溃遗留的未收敛 turn(幂等,inline/bullmq 通用) ---------- */
setTimeout(async () => {
  try {
    for (const t of await store.staleTurns(15_000)) {
      console.log(`[recover] 启动重投 turn ${t.id}(${t.state})`);
      await dispatcher.kick(t.thread_id, t.id);
    }
  } catch (e: any) { console.error('[recover]', e?.message ?? e); }
}, 3000);

/* ---------- 优雅退出:先停调度器再关 HTTP,5s 兜底强退 ---------- */
let shuttingDown = false;
for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.on(s, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] 收到 ${s},优雅退出…`);
    const force = setTimeout(() => process.exit(1), 5000);
    (force as any).unref?.();
    void Promise.allSettled([dispatcher.close(), app.close()]).then(() => process.exit(0));
  });
}
