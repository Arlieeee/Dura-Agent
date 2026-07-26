/** my-agent API 层 E2E:直连 localhost:8787,输出 PASS/FAIL 列表。 */
const API = 'http://localhost:8787';
const RUN = Math.random().toString(36).slice(2, 7);
const results = [];
let passCnt = 0, failCnt = 0;

function ok(id, cond, note = '') {
  results.push({ id, pass: !!cond, note });
  if (cond) passCnt++; else failCnt++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${id}${note ? '  — ' + note : ''}`);
}

async function j(path, opts = {}, token) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
  });
  let body = null;
  const ct = r.headers.get('content-type') ?? '';
  if (ct.includes('json')) body = await r.json().catch(() => null);
  else body = await r.text().catch(() => null);
  return { status: r.status, body, headers: r.headers };
}

/** 读 SSE 流直到 finish 或超时,返回 chunk 数组 */
async function sse(path, opts = {}, token, timeoutMs = 90000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const r = await fetch(API + path, {
    ...opts, signal: ctl.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  const chunks = [];
  const ctype = r.headers.get('content-type') ?? '';
  if (!r.body) { clearTimeout(timer); return { ctype, chunks }; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 2);
        if (line.startsWith('data:')) chunks.push(JSON.parse(line.slice(5)));
      }
      if (chunks.some(c => c.type === 'finish')) break;
    }
  } catch (e) { /* abort = 超时 */ }
  clearTimeout(timer); ctl.abort();
  return { ctype, chunks };
}

const U = (s) => `e2e_${s}_${RUN}`;

/* ================= A 认证 ================= */
console.log('--- A 认证 ---');
const a1 = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: U('a'), password: 'pass1234' }) });
ok('A1 首次登录自动注册返回 token', a1.status === 200 && a1.body.token && a1.body.user?.username === U('a'));
const tokA = a1.body.token, uidA = a1.body.user.id;

const a2 = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: U('a'), password: 'wrong999' }) });
ok('A2 同名用户密码错误 401', a2.status === 401);

const a3a = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'pass1234' }) });
const a3b = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: U('c'), password: '12' }) });
ok('A3 非法用户名/过短密码 400', a3a.status === 400 && a3b.status === 400);

const a4 = await j('/api/me', {}, tokA);
ok('A4 /api/me 返回正确用户名', a4.status === 200 && a4.body.username === U('a'));

const a5 = await j('/api/threads');
ok('A5 无 token 401', a5.status === 401);

const a6 = await j('/api/threads', {}, uidA + '.deadbeefdeadbeefdeadbeefdeadbeef');
ok('A6 伪造签名 token 401', a6.status === 401);

const a7 = await j('/api/threads', {}, 'usr_nonexist.' + tokA.split('.')[1]);
ok('A7 签名不匹配的拼接 token 401', a7.status === 401);

// A8 并发同名注册(两个首次登录同时到达)
const nm = U('race');
const [r1, r2] = await Promise.all([
  j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: nm, password: 'pass1234' }) }),
  j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: nm, password: 'pass1234' }) }),
]);
const codes = [r1.status, r2.status].sort();
ok('A8 并发同名首次登录不产生 5xx', codes.every(c => c < 500), `got ${codes.join(',')}`);

/* ================= B thread 管理 ================= */
console.log('--- B thread ---');
const b1 = await j('/api/threads', { method: 'POST', body: '{}' }, tokA);
ok('B1 创建 thread', b1.status === 200 && b1.body.id?.startsWith('thr_'));
const thrA = b1.body.id;

const b2 = await j('/api/threads', {}, tokA);
ok('B2 列表包含且初始标题「新会话」', Array.isArray(b2.body) && b2.body.some(t => t.id === thrA && t.title === '新会话'));

const b3 = await j(`/api/threads/${thrA}`, {}, tokA);
ok('B3 空 thread detail 空事件数组', b3.status === 200 && Array.isArray(b3.body.events) && b3.body.events.length === 0);

/* ================= C 多用户隔离 ================= */
console.log('--- C 隔离 ---');
const bLogin = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: U('b'), password: 'pass1234' }) });
const tokB = bLogin.body.token;
const c1 = await j(`/api/threads/${thrA}`, {}, tokB);
ok('C1 B 读 A 的 thread 404', c1.status === 404);
const c2 = await j(`/api/threads/${thrA}/turns`, { method: 'POST', body: JSON.stringify({ text: 'hack' }) }, tokB);
ok('C2 B 向 A 的 thread 发消息 404', c2.status === 404);
const c3 = await j('/api/threads', {}, tokB);
ok('C3 B 的列表不含 A 的 thread', Array.isArray(c3.body) && !c3.body.some(t => t.id === thrA));
const c4 = await j(`/api/threads/${thrA}/state`, {}, tokB);
ok('C4 B 读 A 的 fold state 404', c4.status === 404);
const c5 = await j(`/api/threads/${thrA}/continue`, { method: 'POST', body: JSON.stringify({ turn_id: 't', tool_call_id: 'c', answer: 'x' }) }, tokB);
ok('C5 B continue A 的 thread 404', c5.status === 404);

/* ================= D 输入校验 ================= */
console.log('--- D 校验 ---');
const d1 = await j(`/api/threads/${thrA}/turns`, { method: 'POST', body: JSON.stringify({ text: '' }) }, tokA);
ok('D1 空文本 400', d1.status === 400);
const d2 = await j(`/api/threads/${thrA}/continue`, { method: 'POST', body: JSON.stringify({}) }, tokA);
ok('D2 continue 缺参 400', d2.status === 400);
const d3 = await j('/api/artifacts/doc_nonexist1');
ok('D3 不存在 artifact 404(免鉴权路径)', d3.status === 404);
const d4 = await j(`/api/threads/${thrA}/state`, {}, tokA);
ok('D4 空 thread fold state=idle', d4.status === 200 && d4.body.status === 'idle');
const d5 = await j('/api/threads/thr_nonexist/turns', { method: 'POST', body: JSON.stringify({ text: 'hi' }) }, tokA);
ok('D5 不存在的 thread 发 turn 404', d5.status === 404);

/* ================= E 真实 LLM turn 全链路 ================= */
console.log('--- E LLM turn(真实调用,约 10-30s)---');
const eMsg = '请不要调用任何工具,直接回复两个字:收到';
const e = await sse(`/api/threads/${thrA}/turns`, { method: 'POST', body: JSON.stringify({ text: eMsg }) }, tokA);
ok('E1 响应为 text/event-stream', e.ctype.includes('text/event-stream'));
ok('E2 SSE 以 start 开头', e.chunks[0]?.type === 'start');
ok('E3 含 text-delta', e.chunks.some(c => c.type === 'text-delta'));
ok('E4 含 usage', e.chunks.some(c => c.type === 'usage'));
ok('E5 以 finish 结尾且 reason=stop', e.chunks.at(-1)?.type === 'finish' && e.chunks.at(-1)?.finish_reason === 'stop');
const turnE = e.chunks[0]?.turn_id;

const eDetail = await j(`/api/threads/${thrA}`, {}, tokA);
const evts = eDetail.body.events;
const kindsE = evts.filter(x => x.turn_id === turnE).map(x => x.kind);
ok('E6 事件按序落库', JSON.stringify(kindsE) === JSON.stringify(['turn.started', 'user.message', 'assistant.message', 'turn.finished']), kindsE.join('>'));
const am = evts.find(x => x.turn_id === turnE && x.kind === 'assistant.message');
ok('E7 assistant.message 含 usage', am && am.payload.usage?.prompt_tokens > 0);
ok('E8 回复文本已持久化', am && typeof am.payload.text === 'string' && am.payload.text.length > 0, am?.payload.text?.slice(0, 20));
const eList = await j('/api/threads', {}, tokA);
const thrRow = eList.body.find(t => t.id === thrA);
ok('E9 标题自动取首条消息前缀(≤24字)', thrRow && thrRow.title === eMsg.slice(0, 24), thrRow?.title);
ok('E10 updated_at 已刷新(列表排序依据)', thrRow && (Date.now() - new Date(thrRow.updated_at).getTime()) < 5 * 60_000);

/* ================= G 挂起/恢复(先于 F,产生 confirmation 供 F 幂等测试)================= */
console.log('--- G 挂起/恢复(真实调用)---');
const g = await sse(`/api/threads/${thrA}/turns`, { method: 'POST', body: JSON.stringify({ text: '请立刻调用 ask_user 工具问我「选A还是选B?」,并给出选项A、B。不要自己回答。' }) }, tokA);
const susp = g.chunks.find(c => c.type === 'suspend');
ok('G1 收到 suspend chunk(问题+选项)', !!susp && typeof susp.question === 'string' && susp.question.length > 0, susp?.question);
ok('G2 挂起 finish_reason=tool-calls', g.chunks.at(-1)?.type === 'finish' && g.chunks.at(-1)?.finish_reason === 'tool-calls');
const turnG = g.chunks[0]?.turn_id;
const gDetail = await j(`/api/threads/${thrA}`, {}, tokA);
ok('G3 turn.suspended 落库', gDetail.body.events.some(x => x.turn_id === turnG && x.kind === 'turn.suspended'));
const gState = await j(`/api/threads/${thrA}/state?turn_id=${turnG}`, {}, tokA);
ok('G4 fold status=suspended', gState.body.status === 'suspended');

const cont = await sse(`/api/threads/${thrA}/continue`, {
  method: 'POST', body: JSON.stringify({ turn_id: turnG, tool_call_id: susp.tool_call_id, answer: '选A' }),
}, tokA);
ok('G5 continue 后跑完 finish=stop', cont.chunks.at(-1)?.type === 'finish' && cont.chunks.at(-1)?.finish_reason === 'stop');
const gDetail2 = await j(`/api/threads/${thrA}`, {}, tokA);
const gKinds = gDetail2.body.events.filter(x => x.turn_id === turnG).map(x => x.kind);
const expectChain = ['turn.started', 'user.message', 'assistant.message', 'tool.call', 'turn.suspended', 'user.confirmation', 'assistant.message', 'turn.finished'];
ok('G6 完整事件链', JSON.stringify(gKinds) === JSON.stringify(expectChain), gKinds.join('>'));
const finalMsg = gDetail2.body.events.filter(x => x.turn_id === turnG && x.kind === 'assistant.message').at(-1);
ok('G7 最终回复包含所选答案', /A/.test(finalMsg?.payload.text ?? ''), finalMsg?.payload.text?.slice(0, 40));
const gState2 = await j(`/api/threads/${thrA}/state?turn_id=${turnG}`, {}, tokA);
ok('G8 fold status=finished', gState2.body.status === 'finished');

/* ================= F 幂等性 ================= */
console.log('--- F 幂等 ---');
const cntBefore = (await j(`/api/threads/${thrA}`, {}, tokA)).body.events.length;
// 重放同一 confirmation:确定性事件 ID 应 no-op;turn 已 finished,decide=noop,不重复执行
const replay = await sse(`/api/threads/${thrA}/continue`, {
  method: 'POST', body: JSON.stringify({ turn_id: turnG, tool_call_id: susp.tool_call_id, answer: '选A' }),
}, tokA, 20000);
const cntAfter = (await j(`/api/threads/${thrA}`, {}, tokA)).body.events.length;
ok('F1 重放同一 confirmation 零新增事件', cntAfter === cntBefore, `${cntBefore}→${cntAfter}`);
ok('F2 重放后 fold 仍 finished(未重跑)', (await j(`/api/threads/${thrA}/state?turn_id=${turnG}`, {}, tokA)).body.status === 'finished');

/* ================= H artifacts ================= */
console.log('--- H artifacts(真实调用 write_document,约 30-90s)---');
const h = await sse(`/api/threads/${thrA}/turns`, { method: 'POST', body: JSON.stringify({ text: '请直接调用 write_document 工具,写一篇标题为「测试文档」、正文 100 字左右介绍 event sourcing 的短文,然后简短总结。' }) }, tokA, 120000);
const toolOut = h.chunks.find(c => c.type === 'tool-output-available' && c.output?.artifact_id);
ok('H1 write_document 返回 artifact_id', !!toolOut, JSON.stringify(toolOut?.output ?? {}).slice(0, 60));
if (toolOut) {
  const art = await j(`/api/artifacts/${toolOut.output.artifact_id}`);
  ok('H2 artifact 免鉴权可读且为 markdown', art.status === 200 && typeof art.body === 'string' && art.body.length > 20);
  const hDetail = await j(`/api/threads/${thrA}`, {}, tokA);
  ok('H3 thread detail 返回 artifacts 列表', hDetail.body.artifacts.some(x => x.id === toolOut.output.artifact_id));
} else { ok('H2 (跳过:无 artifact)', false); ok('H3 (跳过:无 artifact)', false); }
ok('H4 tool-input-start 流式信号存在', h.chunks.some(c => c.type === 'tool-input-start' && c.tool_name === 'write_document'));

/* ================= I 边界 ================= */
console.log('--- I 边界 ---');
const long = 'x'.repeat(5000);
const i1 = await sse(`/api/threads/${thrA}/turns`, { method: 'POST', body: JSON.stringify({ text: '请不要调用任何工具,直接回复:好。' + long }) }, tokA);
const i1detail = await j(`/api/threads/${thrA}`, {}, tokA);
const i1msg = i1detail.body.events.filter(x => x.kind === 'user.message').at(-1);
ok('I1 超长输入截断到 4000', i1msg.payload.text.length === 4000);
ok('I2 超长输入 turn 正常收敛', i1.chunks.at(-1)?.type === 'finish');

const i3Before = (await j(`/api/threads/${thrA}`, {}, tokA)).body.events.length;
const i3 = await sse(`/api/threads/${thrA}/continue`, { method: 'POST', body: JSON.stringify({ turn_id: 'trn_fake', tool_call_id: 'call_fake', answer: 'x' }) }, tokA, 15000);
const i3After = (await j(`/api/threads/${thrA}`, {}, tokA)).body.events.length;
ok('I3 伪造 continue 返回终态流且零事件追加', i3.chunks.at(-1)?.type === 'finish' && i3After === i3Before, `${i3Before}→${i3After}`);

/* ================= J 服务加固(第三轮新增) ================= */
console.log('--- J 加固 ---');
const j1 = await j('/healthz');
ok('J1 healthz 返回 ok+store+runner', j1.status === 200 && j1.body.ok === true && j1.body.store && j1.body.runner, JSON.stringify(j1.body));

// token 防篡改:把 exp 段改大(签名不再匹配)→ 401
const [uidPart, expPart, sigPart] = tokA.split('.');
ok('J2 token 结构为三段(带过期)', !!uidPart && /^\d+$/.test(expPart ?? '') && (sigPart ?? '').length === 32);
const j3 = await j('/api/me', {}, `${uidPart}.${Number(expPart) + 86400}.${sigPart}`);
ok('J3 篡改 exp 的 token 401', j3.status === 401);

// turns 限流:独立用户快速打空 text(不产生真实 turn),前 10 次 400,之后 429
const rl = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: U('rl'), password: 'pass1234' }) });
const rlThr = (await j('/api/threads', { method: 'POST', body: '{}' }, rl.body.token)).body.id;
let got429 = 0, got400 = 0;
for (let i = 0; i < 12; i++) {
  const r = await j(`/api/threads/${rlThr}/turns`, { method: 'POST', body: JSON.stringify({ text: '' }) }, rl.body.token);
  if (r.status === 429) got429++;
  if (r.status === 400) got400++;
}
ok('J4 turns 限流生效(10/min 后 429)', got400 === 10 && got429 === 2, `400×${got400} 429×${got429}`);

console.log(`\n===== ${passCnt} PASS / ${failCnt} FAIL =====`);
process.exit(failCnt ? 1 : 0);
