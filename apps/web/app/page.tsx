'use client';
/** Dura-Agent 聊天前端 v5:素瓷·墨设计语言(朱砂印 logo/落款式状态/水墨动效)
 *  + 账号登录 + 会话侧边栏 + 打字机/parts/thinking 折叠/工具人话渲染/artifacts 面板/token 用量 */
import { useEffect, useRef, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_HOST
  ?? (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:8787` : 'http://localhost:8787');

/* ================= 内联图标(tabler 风格) ================= */
function Ic({ n, s = 13 }: { n: string; s?: number }) {
  const P: Record<string, React.ReactNode> = {
    'chev-r': <path d="M9 6l6 6l-6 6" />,
    'chev-d': <path d="M6 9l6 6l6 -6" />,
    bulb: <><path d="M9 18h6" /><path d="M10 21h4" /><path d="M12 3a6 6 0 0 1 4 10.4c-.7.6-1 1.3-1 2.1v.5h-6v-.5c0-.8-.3-1.5-1-2.1A6 6 0 0 1 12 3z" /></>,
    tool: <path d="M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5" />,
    file: <><path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /></>,
    check: <path d="M5 12l5 5l10 -10" />,
    x: <path d="M18 6l-12 12M6 6l12 12" />,
    ext: <><path d="M11 7h-5a2 2 0 0 0 -2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2 -2v-5" /><path d="M10 14l10 -10" /><path d="M15 4h5v5" /></>,
    search: <><circle cx="10" cy="10" r="7" /><path d="M21 21l-6 -6" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a13 13 0 0 1 0 18a13 13 0 0 1 0 -18" /></>,
    help: <><circle cx="12" cy="12" r="9" /><path d="M12 17v.01" /><path d="M12 13.5a1.5 1.5 0 0 1 1 -1.5a2.6 2.6 0 1 0 -3 -2.6" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    msg: <path d="M8 9h8M8 13h6M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z" />,
    logout: <><path d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2" /><path d="M9 12h12l-3 -3M18 15l3 -3" /></>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>,
    up: <path d="M12 19V5M5 12l7 -7l7 7" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  };
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, verticalAlign: '-2px' }}>{P[n]}</svg>;
}

/* ================= 朱砂印「一笔 D」logo ================= */
function Seal() {
  return (
    <svg className="mark" viewBox="0 0 28 28" aria-label="Dura-Agent 印章">
      <rect x="1" y="1" width="26" height="26" rx="5.2" fill="#a63b2a" />
      <rect x="3.4" y="3.4" width="21.2" height="21.2" rx="3.4" fill="none" stroke="rgba(255,255,255,.26)" strokeWidth=".8" />
      <path d="M9.8 7.6 V20.4" stroke="#f7f3ec" strokeWidth="3" strokeLinecap="round" />
      <path d="M10.4 8.8 C16.6 8.1 19.6 10.7 19.6 13.9 C19.6 16.9 17.5 19 14 19.7" stroke="#f7f3ec" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/* ================= 迷你 Markdown ================= */
function fixUnclosed(md: string): string {
  if ((md.match(/```/g) ?? []).length % 2 === 1) md += '\n```';
  else {
    if ((md.match(/\*\*/g) ?? []).length % 2 === 1 && /\*\*[^*]*$/.test(md)) md += '**';
    const ticks = (md.match(/`/g) ?? []).length - (md.match(/```/g) ?? []).length * 3;
    if (ticks % 2 === 1 && /`[^`]*$/.test(md)) md += '`';
  }
  return md;
}
function inline(s: string): string {
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const href = u.startsWith('/') ? API + u : u;
    return `<a href="${href}" target="_blank" rel="noreferrer">${t}</a>`;
  });
  return s;
}
function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chunks = fixUnclosed(src).split('```');
  let html = '';
  for (let i = 0; i < chunks.length; i++) {
    if (i % 2 === 1) {
      const nl = chunks[i].indexOf('\n');
      html += `<pre><code>${esc(nl >= 0 ? chunks[i].slice(nl + 1) : chunks[i])}</code></pre>`;
      continue;
    }
    const out: string[] = []; let list: 'ul' | 'ol' | null = null; let inTable = false; let rows: string[] = []; let para: string[] = [];
    const fP = () => { if (para.length) { out.push('<p>' + para.join('<br/>') + '</p>'); para = []; } };
    const fL = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const fT = () => { if (rows.length) { out.push('<table>' + rows.join('') + '</table>'); rows = []; } inTable = false; };
    for (const line of chunks[i].split('\n')) {
      let m;
      if (/^\s*$/.test(line)) { fP(); fL(); fT(); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) { fP(); fL(); fT(); const l = Math.min(m[1].length + 1, 5); out.push(`<h${l}>` + inline(m[2]) + `</h${l}>`); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { fP(); fL(); fT(); out.push('<hr/>'); continue; }
      if ((m = line.match(/^\s*>\s?(.*)/))) { fP(); fL(); fT(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); continue; }
      if (/\|/.test(line) && /^\s*\|/.test(line)) {
        fP(); fL();
        if (/^\s*\|?\s*:?-{2,}/.test(line)) { inTable = true; continue; }
        const tag = inTable ? 'td' : 'th';
        const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => inline(c.trim()));
        rows.push('<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>');
        continue;
      }
      if ((m = line.match(/^\s*[-*+]\s+(.*)/))) { fP(); fT(); if (list !== 'ul') { fL(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { fP(); fT(); if (list !== 'ol') { fL(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(m[1]) + '</li>'); continue; }
      para.push(inline(line));
    }
    fP(); fL(); fT();
    html += out.join('\n');
  }
  return html;
}
function Md({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;
}

/* ================= 工具展示元数据 ================= */
const TOOL_META: Record<string, { label: string; icon: string; running: string }> = {
  web_search: { label: '联网搜索', icon: 'search', running: '正在搜索' },
  write_document: { label: '撰写文档', icon: 'file', running: '正在撰写' },
  ask_user: { label: '向你确认', icon: 'help', running: '等待你的回答' },
};
const toolMeta = (name: string) => TOOL_META[name] ?? { label: name.replace(/_/g, ' '), icon: 'tool', running: '正在执行' };
function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u.slice(0, 40); }
}
function toolSummary(p: ToolPart): string {
  const inp: any = p.input ?? {}; const out: any = p.output ?? {};
  if (p.preparing) return p.name === 'write_document' ? `正在撰写内容${p.prepChars ? ` · 约 ${p.prepChars} 字` : ''}…` : '准备中…';
  if (p.name === 'web_search') return inp.query ? `「${String(inp.query).slice(0, 40)}」${Array.isArray(out.results) ? ` · ${out.results.length} 条结果` : ''}` : '';
  if (p.name === 'write_document') return inp.title ? `《${String(inp.title).slice(0, 30)}》${out.artifact_id ? ' · 已生成' : ''}` : '';
  if (p.name === 'ask_user') return String(inp.question ?? '').slice(0, 48);
  return '';
}
function fmtTok(n: number) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/* ================= 模型 ================= */
interface RPart { kind: 'reasoning'; id: string; text: string }
interface TPart { kind: 'text'; id: string; text: string }
interface ToolPart { kind: 'tool'; id: string; name: string; input?: unknown; output?: unknown; ok?: boolean; progress?: unknown;
  preparing?: boolean; prepChars?: number;
  suspended?: { question: string; options?: string[] }; answered?: string }
type Part = RPart | TPart | ToolPart;
interface Msg { id: string; role: 'user' | 'assistant'; parts: Part[]; usage?: { pin: number; pout: number } }
type Status = 'ready' | 'streaming' | 'waiting-user';
interface Doc { id: string; title: string; content: string }
interface ThreadItem { id: string; title: string; updated_at: string }
interface Auth { token: string; user: { id: string; username: string } }

/* ================= 入口:登录门 ================= */
export default function Page() {
  const [auth, setAuth] = useState<Auth | null | undefined>(undefined);   // undefined = 尚未读取
  useEffect(() => {
    try { setAuth(JSON.parse(localStorage.getItem('auth') ?? 'null')); } catch { setAuth(null); }
  }, []);
  if (auth === undefined) return null;
  if (!auth) return <Login onLogin={a => { localStorage.setItem('auth', JSON.stringify(a)); setAuth(a); }} />;
  return <Main auth={auth} onLogout={() => { localStorage.removeItem('auth'); setAuth(null); }} />;
}

function Login({ onLogin }: { onLogin: (a: Auth) => void }) {
  const [username, setU] = useState(''); const [password, setP] = useState(''); const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!username || !password || busy) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`${API}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? '登录失败'); return; }
      onLogin(j);
    } catch { setErr('无法连接服务器'); } finally { setBusy(false); }
  }
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-seal"><Seal /><b>Dura<span>-Agent</span></b></div>
        <p className="login-sub serif">登录或注册 · 首次登录自动创建账号</p>
        <input placeholder="用户名" value={username} onChange={e => setU(e.target.value)} />
        <input placeholder="密码(至少 4 位)" type="password" value={password} onChange={e => setP(e.target.value)}
               onKeyDown={e => e.key === 'Enter' && submit()} />
        {err && <div className="login-err">{err}</div>}
        <button className="primary serif" onClick={submit} disabled={busy}>{busy ? '…' : '进 入'}</button>
      </div>
    </div>
  );
}

/* ================= 主界面 ================= */
function Main({ auth, onLogout }: { auth: Auth; onLogout: () => void }) {
  const [threads, setThreads] = useState<ThreadItem[]>([]);
  const [threadId, setThreadId] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>('ready');
  const [input, setInput] = useState('');
  const [artifacts, setArtifacts] = useState<{ id: string; title: string }[]>([]);
  const [durs, setDurs] = useState<Record<string, number>>({});
  const [panel, setPanel] = useState(false);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [sideOpen, setSideOpen] = useState(true);
  const turnRef = useRef('');
  const viewRef = useRef('');                       // 当前正在查看的 thread(chunk 作用域闸门)
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const threadKey = `thread:${auth.user.id}`;

  /** 带鉴权的 fetch;401 自动登出 */
  async function api(path: string, init: RequestInit = {}): Promise<Response> {
    const r = await fetch(`${API}${path}`, {
      ...init, headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (r.status === 401) { onLogout(); throw new Error('unauthorized'); }
    return r;
  }

  /** 打开一条 SSE 流:先中止上一条;chunk 严格限定在发起时的 thread */
  async function openStream(tid: string, path: string, init: RequestInit = {}) {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const res = await api(path, { ...init, signal: ctl.signal });
      if (!res.ok) {                                   // 限流(429)等非流式错误:落一条可见提示
        const err = await res.json().catch(() => ({} as any));
        if (viewRef.current === tid) {
          setStatus('ready');
          setMsgs(prev => [...prev, { id: 'err' + Date.now(), role: 'assistant', parts: [{ kind: 'text', id: 't', text: `⚠️ 请求失败(${res.status}):${err.error ?? '未知错误'}` }] }]);
        }
        return;
      }
      await consume(res, tid, ctl);
    } catch (e: any) { if (e?.name !== 'AbortError') throw e; }
  }

  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;           // StrictMode 双跑防重入(否则会创建两个初始 thread)
    bootedRef.current = true;
    void init();
  }, []);
  useEffect(() => { listRef.current?.scrollTo(0, 1e9); }, [msgs]);

  async function refreshThreads(): Promise<ThreadItem[]> {
    const list = await (await api('/api/threads')).json();
    setThreads(list); return list;
  }
  async function init() {
    const list = await refreshThreads();
    const saved = localStorage.getItem(threadKey);
    const target = list.find((t: ThreadItem) => t.id === saved)?.id ?? list[0]?.id;
    if (target) await switchThread(target);
    else newThread();                        // 没有任何会话:进入草稿态,不落库
  }
  /** 重置视图到指定 thread(tid='' 表示草稿态:还没创建、发首条消息时才落库) */
  function resetView(tid: string) {
    viewRef.current = tid;
    abortRef.current?.abort();                      // 旧流立即中止,不再污染新视图
    twRef.current.clear(); queueRef.current = []; turnRef.current = '';
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setMsgs([]); setStatus('ready'); setDurs({}); setThreadId(tid); setDoc(null); setArtifacts([]);
  }
  /** 新会话 = 纯前端草稿,不创建 thread(否则空「新会话」会在列表里累积) */
  function newThread() { resetView(''); }
  /** 切换会话:清空本地流状态(服务端 turn 继续跑,回来时自动重连) */
  async function switchThread(tid: string) {
    resetView(tid);
    localStorage.setItem(threadKey, tid);
    await coldLoad(tid);
  }

  async function coldLoad(tid: string) {
    const r = await api(`/api/threads/${tid}`); if (!r.ok) return;
    const { events, artifacts } = await r.json();
    setArtifacts(artifacts ?? []);
    const out: Msg[] = [];
    const byTool = new Map<string, ToolPart>();
    let cur: Msg | null = null;
    const asst = (turn: string) => {
      if (!cur || cur.id !== turn + '-assistant') { cur = { id: turn + '-assistant', role: 'assistant', parts: [] }; out.push(cur); }
      return cur;
    };
    for (const e of events) {
      const p = e.payload;
      if (e.kind === 'user.message') { out.push({ id: e.id, role: 'user', parts: [{ kind: 'text', id: 't', text: p.text }] }); cur = null; }
      if (e.kind === 'assistant.message') {
        const m = asst(e.turn_id);
        if (p.reasoning) m.parts.push({ kind: 'reasoning', id: 'r' + p.step, text: p.reasoning });
        if (p.text) m.parts.push({ kind: 'text', id: 't' + p.step, text: p.text });
        if (p.usage) m.usage = { pin: (m.usage?.pin ?? 0) + (p.usage.prompt_tokens ?? 0), pout: (m.usage?.pout ?? 0) + (p.usage.completion_tokens ?? 0) };
      }
      if (e.kind === 'tool.call') { const m = asst(e.turn_id); const t: ToolPart = { kind: 'tool', id: p.tool_call_id, name: p.name, input: p.args }; m.parts.push(t); byTool.set(t.id, t); }
      if (e.kind === 'tool.result') { const t = byTool.get(p.tool_call_id); if (t) { t.output = p.output; t.ok = p.ok; } }
      if (e.kind === 'turn.suspended') { const t = byTool.get(p.tool_call_id); if (t && !t.answered) t.suspended = { question: p.question, options: p.options }; }
      if (e.kind === 'user.confirmation') { const t = byTool.get(p.tool_call_id); if (t) { t.answered = p.answer; t.suspended = undefined; } }
    }
    setMsgs(out);
    const started = events.filter((e: any) => e.kind === 'turn.started').map((e: any) => e.turn_id);
    const settled = new Set(events.filter((e: any) => e.kind === 'turn.finished' || e.kind === 'turn.suspended').map((e: any) => e.turn_id));
    const live = started.find((t: string) => !settled.has(t));
    if (live) { turnRef.current = live; void openStream(tid, `/api/threads/${tid}/sse`); }
  }

  /* ============ 打字机引擎 ============ */
  const segRef = useRef<Intl.Segmenter | null>(null);
  const twRef = useRef(new Map<string, string[]>());
  const rafRef = useRef<number | null>(null);
  const rzRef = useRef<{ key: string; start: number } | null>(null);

  function segWords(text: string): string[] {
    segRef.current ??= new Intl.Segmenter('zh', { granularity: 'word' });
    return Array.from(segRef.current.segment(text), s => s.segment);
  }
  function closeReasoning() {
    const r = rzRef.current;
    if (r) { setDurs(prev => prev[r.key] ? prev : { ...prev, [r.key]: Math.max(1, Math.round((Date.now() - r.start) / 1000)) }); rzRef.current = null; }
  }
  function twPush(partKey: string, delta: string) {
    const q = twRef.current.get(partKey) ?? [];
    q.push(...segWords(delta));
    twRef.current.set(partKey, q);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(twLoop);
  }
  function twApply(drained: Record<string, string>) {
    setMsgs(prev => prev.map(m => ({
      ...m,
      parts: m.parts.map(p => {
        const add = drained[m.id + '|' + p.id];
        return add !== undefined && p.kind !== 'tool' ? { ...p, text: p.text + add } : { ...p };
      }),
    })));
  }
  function twLoop() {
    const active = [...twRef.current.entries()].filter(([, q]) => q.length);
    if (!active.length) { rafRef.current = null; return; }
    const drained: Record<string, string> = {};
    for (const [key, q] of active) drained[key] = q.splice(0, Math.max(1, Math.floor(q.length / 5))).join('');
    twApply(drained);
    rafRef.current = requestAnimationFrame(twLoop);
  }
  /** 一次性排空队列:turn 结束时调用。rAF 在后台标签页不触发,不排空的话正文会一直空着 */
  function twDrainAll() {
    const drained: Record<string, string> = {};
    let any = false;
    for (const [key, q] of twRef.current) if (q.length) { drained[key] = q.splice(0).join(''); any = true; }
    if (any) twApply(drained);
  }

  /* ============ SSE ============ */
  const queueRef = useRef<any[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function consume(res: Response, tid: string, ctl: AbortController) {
    if (viewRef.current !== tid) return;
    setStatus('streaming');
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      // 视图已切走或流被中止:静默退出,不再往 reducer 里灌 chunk
      if (ctl.signal.aborted || viewRef.current !== tid) { void reader.cancel(); return; }
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 2);
        if (line.startsWith('data:')) enqueue(JSON.parse(line.slice(5)));
      }
    }
    if (viewRef.current === tid) flush();
  }
  function enqueue(c: any) {
    if (c.type === 'start') turnRef.current = c.turn_id;
    queueRef.current.push(c);
    if (!timerRef.current) timerRef.current = setTimeout(flush, 40);
  }
  function flush() {
    timerRef.current = null;
    const batch = queueRef.current; queueRef.current = [];
    if (!batch.length) return;
    const mid = turnRef.current + '-assistant';

    let gotOutput = false; let finished = false;
    const newParts: Part[] = [];
    const seen = new Set<string>();
    const usageAdd = { pin: 0, pout: 0 };
    for (const c of batch) {
      if (c.type === 'tool-output-available') gotOutput = true;
      if (c.type === 'suspend') setStatus('waiting-user');
      if (c.type === 'finish') { closeReasoning(); if (c.finish_reason !== 'tool-calls') { setStatus('ready'); finished = true; } }
      if (c.type === 'finish' || c.type === 'suspend') queueMicrotask(twDrainAll);   // 部件先入列,再排空
      if (c.type === 'usage') { usageAdd.pin += c.prompt_tokens; usageAdd.pout += c.completion_tokens; }
      if (c.type === 'reasoning-delta') {
        const id = 'r' + c.step, key = mid + '|' + id;
        if (!seen.has(id)) { seen.add(id); newParts.push({ kind: 'reasoning', id, text: '' }); }
        if (rzRef.current?.key !== key) { closeReasoning(); rzRef.current = { key, start: Date.now() }; }
        twPush(key, c.delta);
      }
      if (c.type === 'text-delta') {
        const id = 't' + c.step;
        if (!seen.has(id)) { seen.add(id); newParts.push({ kind: 'text', id, text: '' }); }
        closeReasoning();
        twPush(mid + '|' + id, c.delta);
      }
      if (c.type === 'tool-input-start') {
        closeReasoning();
        if (!seen.has(c.tool_call_id)) { seen.add(c.tool_call_id); newParts.push({ kind: 'tool', id: c.tool_call_id, name: c.tool_name, preparing: true }); }
      }
      if (c.type === 'tool-input-delta') {
        // 中途重连时可能没收到过 start:据 delta 自建卡片(updater 侧有去重)
        if (!seen.has(c.tool_call_id)) { seen.add(c.tool_call_id); newParts.push({ kind: 'tool', id: c.tool_call_id, name: c.tool_name ?? 'tool', preparing: true, prepChars: c.chars }); }
      }
      if (c.type === 'tool-input-available') {
        closeReasoning();
        if (!seen.has(c.tool_call_id)) { seen.add(c.tool_call_id); newParts.push({ kind: 'tool', id: c.tool_call_id, name: c.tool_name, input: c.input }); }
      }
    }
    if (gotOutput) void refreshArtifacts();
    if (finished) void refreshThreads();     // 标题/排序可能变了

    setMsgs(prev => {
      const next = prev.map(m => ({ ...m, parts: m.parts.map(p => ({ ...p })) }));
      let m = next.find(x => x.id === mid);
      if (!m && (newParts.length || usageAdd.pin)) { m = { id: mid, role: 'assistant', parts: [] }; next.push(m); }
      if (m) {
        for (const np of newParts) if (!m.parts.some(p => p.id === np.id)) m.parts.push({ ...np });
        if (usageAdd.pin || usageAdd.pout) m.usage = { pin: (m.usage?.pin ?? 0) + usageAdd.pin, pout: (m.usage?.pout ?? 0) + usageAdd.pout };
        const tool = (id: string) => m!.parts.find(x => x.kind === 'tool' && x.id === id) as ToolPart | undefined;
        for (const c of batch) {
          if (c.type === 'tool-input-delta') { const t = tool(c.tool_call_id); if (t) t.prepChars = c.chars; }
          if (c.type === 'tool-input-available') { const t = tool(c.tool_call_id); if (t) { t.input = c.input; t.preparing = false; t.prepChars = undefined; } }
          if (c.type === 'tool-progress') { const t = tool(c.tool_call_id); if (t) t.progress = c.data; }
          if (c.type === 'tool-output-available') { const t = tool(c.tool_call_id); if (t) { t.output = c.output; t.ok = c.ok; t.progress = undefined; } }
          if (c.type === 'suspend') { const t = tool(c.tool_call_id); if (t) t.suspended = { question: c.question, options: c.options }; }
        }
      }
      return next;
    });
  }
  async function refreshArtifacts() {
    const tid = viewRef.current; if (!tid) return;
    const r = await api(`/api/threads/${tid}`); if (r.ok && viewRef.current === tid) setArtifacts((await r.json()).artifacts ?? []);
  }

  /* ---------- artifacts 面板 ---------- */
  async function openDoc(id: string) {
    const title = artifacts.find(a => a.id === id)?.title ?? id;
    setPanel(true); setDoc({ id, title, content: '加载中…' });
    const r = await fetch(`${API}/api/artifacts/${id}`);
    setDoc({ id, title, content: r.ok ? await r.text() : '加载失败' });
  }
  function mdClick(e: React.MouseEvent) {
    const a = (e.target as HTMLElement).closest('a');
    if (a && a.href.includes('/api/artifacts/')) { e.preventDefault(); void openDoc(a.href.split('/').pop()!); }
  }

  /* ---------- 发送 / 答复 ---------- */
  async function send() {
    if (!input.trim() || status !== 'ready') return;
    const text = input; setInput('');
    setMsgs(prev => [...prev, { id: 'u' + Date.now(), role: 'user', parts: [{ kind: 'text', id: 't', text }] }]);
    let tid = threadId;
    if (!tid) {                              // 草稿态:发首条消息时才真正创建 thread
      const { id } = await (await api('/api/threads', { method: 'POST', body: '{}' })).json();
      tid = id; viewRef.current = tid; setThreadId(tid);
      localStorage.setItem(threadKey, tid);
    }
    void openStream(tid, `/api/threads/${tid}/turns`, { method: 'POST', body: JSON.stringify({ text }) });
    void refreshThreads();
  }
  async function answer(toolCallId: string, ans: string) {
    setMsgs(prev => prev.map(m => ({ ...m, parts: m.parts.map(p => p.kind === 'tool' && p.id === toolCallId ? { ...p, suspended: undefined, answered: ans } : { ...p }) })));
    void openStream(threadId, `/api/threads/${threadId}/continue`, {
      method: 'POST', body: JSON.stringify({ turn_id: turnRef.current, tool_call_id: toolCallId, answer: ans }),
    });
  }

  async function stop() {
    if (!threadId) return;
    await api(`/api/threads/${threadId}/cancel`, { method: 'POST', body: '{}' });
    // 流式中的 turn 会从流里收到 finish(cancelled);挂起中的没有打开的流,直接按日志重建
    if (status === 'waiting-user') { setStatus('ready'); void coldLoad(threadId); }
  }

  /* ---------- 渲染 ---------- */
  const lastAsst = [...msgs].reverse().find(m => m.role === 'assistant');
  /** 落款式状态文字(无指示灯):就绪/候示/思考中/调用中/书写中 */
  function statText(): string {
    if (status === 'ready') return '就绪';
    if (status === 'waiting-user') return '候示';
    const p = lastAsst?.parts[lastAsst.parts.length - 1];
    if (p?.kind === 'reasoning') return '思考中';
    if (p?.kind === 'tool') return '调用中';
    return '书写中';
  }
  function activityLabel(): string {
    const parts = lastAsst?.parts ?? [];
    const p = parts[parts.length - 1];
    if (!p) return '正在启动';
    if (p.kind === 'reasoning') return '思考中';
    if (p.kind === 'text') return '生成回复';
    if (p.kind === 'tool') {
      const meta = toolMeta(p.name);
      if (p.preparing) return `${meta.running}${p.prepChars ? ` · 约 ${p.prepChars} 字` : ''}`;
      if (p.output === undefined && !p.suspended && !p.answered) return meta.running;
      return '继续推理';
    }
    return '运行中';
  }
  function renderParts(m: Msg) {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < m.parts.length; i++) {
      const p = m.parts[i];
      if (p.kind === 'tool') {
        const grp: ToolPart[] = [];
        let j = i;
        while (j < m.parts.length && m.parts[j].kind === 'tool') { grp.push(m.parts[j] as ToolPart); j++; }
        const cards = grp.map(t => <ToolCard key={t.id} part={t} onAnswer={answer} onOpenDoc={openDoc} />);
        if (grp.length > 1) {
          const done = grp.filter(t => t.output !== undefined || t.answered).length;
          out.push(<div className="toolgroup" key={'g' + grp[0].id}>
            <div className="tg-head"><Ic n="tool" s={12} /> {done < grp.length ? `正在使用工具(${done}/${grp.length})` : `使用了 ${grp.length} 个工具`}</div>{cards}</div>);
        } else out.push(cards[0]);
        i = j - 1; continue;
      }
      const liveTail = m === lastAsst && i === m.parts.length - 1 && status === 'streaming';
      if (p.kind === 'reasoning') out.push(<Reasoning key={p.id} part={p} live={liveTail} dur={durs[m.id + '|' + p.id]} />);
      else out.push(<div key={p.id} onClick={mdClick}><Md text={p.text} /></div>);
    }
    if (m.usage) out.push(<div key="usage" className="usage">↑{fmtTok(m.usage.pin)} ↓{fmtTok(m.usage.pout)} tokens</div>);
    return out;
  }

  return (
    <div className={`app ${panel ? 'with-panel' : ''}`}>
      <nav className={`side ${sideOpen ? '' : 'closed'}`} aria-hidden={!sideOpen}>
          <div className="logo"><Seal /><b>Dura<span>-Agent</span></b></div>
          <button className="side-new" onClick={newThread}><Ic n="plus" s={14} /> 新对话</button>
          <div className="side-list">
            {threads.map(t => (
              <button key={t.id} className={`side-item ${t.id === threadId ? 'active' : ''}`} onClick={() => switchThread(t.id)}>
                <span className="side-title">{t.title || '新对话'}</span>
                <span className="side-time">{relTime(t.updated_at)}</span>
              </button>
            ))}
          </div>
          <div className="side-user">
            <span className="avatar">{auth.user.username.slice(0, 1).toUpperCase()}</span>
            <span className="uname">{auth.user.username}</span>
            <button className="ghost iconbtn" title="退出登录" onClick={onLogout}><Ic n="logout" s={14} /></button>
          </div>
      </nav>
      <main className="shell">
        <header>
          <button className="icb" title="会话列表" onClick={() => setSideOpen(!sideOpen)}><Ic n="panel" s={16} /></button>
          <h1 className="serif">{threads.find(t => t.id === threadId)?.title || '新对话'}</h1>
          <span className={`stat ${status !== 'ready' ? 'live' : ''}`}>
            {status !== 'ready' && <span className="inkdrop" />}
            <span className="stxt serif">{statText()}</span>
          </span>
          <span className="hspace" />
          <button className="icb" title="文档" onClick={() => { setPanel(!panel); if (!panel) setDoc(null); }}>
            <Ic n="file" s={16} />
            {artifacts.length > 0 && <span className="icb-badge">{artifacts.length}</span>}
          </button>
          <span className={`flowline ${statText() === '书写中' ? 'on' : ''}`} />
        </header>
        <div className="chat" ref={listRef}>
          {msgs.length === 0 && (
            <div className="empty">
              <svg className="enso" viewBox="0 0 200 200" aria-hidden="true">
                <circle className="c1" cx="100" cy="100" r="76" pathLength={100} />
                <circle className="c2" cx="100" cy="100" r="71" pathLength={100} />
              </svg>
              <h3 className="serif">今日，从何谈起？</h3>
              <div className="esub serif">研墨已毕 · 静候示下</div>
              <div className="echips">
                {['搜一个主题并整理成文', '排查一个报错', '写一份周报'].map(s => (
                  <button key={s} className="chip" onClick={() => setInput(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map(m => (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.role === 'user' ? <div className="text">{(m.parts[0] as TPart)?.text}</div> : renderParts(m)}
            </div>
          ))}
          {status === 'streaming' && <div className="activity"><span className="inkdrop" /> {activityLabel()}…</div>}
        </div>
        <footer>
          <div className="inbox">
            <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
                   placeholder="发消息，或描述一件要办的事…" disabled={status !== 'ready'} />
            {status === 'ready'
              ? <button className="send" onClick={send} aria-label="发送"><Ic n="up" s={16} /></button>
              : <button className="send" onClick={stop} aria-label="停止"><Ic n="stop" s={16} /></button>}
          </div>
          <div className="hint">Dura-Agent 可能出错，请核查关键结论 · Enter 发送</div>
        </footer>
      </main>
      <aside className={`panel ${panel ? '' : 'closed'}`} aria-hidden={!panel}>
        <div className="panel-inner">
          <div className="panel-head">
            <b>{doc ? doc.title : `文档(${artifacts.length})`}</b>
            {doc && <a href={`${API}/api/artifacts/${doc.id}`} target="_blank" rel="noreferrer"><Ic n="ext" s={12} /> 原文</a>}
            {doc && <button className="ghost" onClick={() => setDoc(null)}>列表</button>}
            <button className="ghost" onClick={() => setPanel(false)}><Ic n="x" s={13} /></button>
          </div>
          <div className="panel-body">
            {doc
              ? <Md text={doc.content} />
              : artifacts.length
                ? <ul className="doclist">{artifacts.map(a => <li key={a.id}><button onClick={() => openDoc(a.id)}><Ic n="file" /> {a.title}</button></li>)}</ul>
                : <div className="empty">还没有文档。让 agent「整理成文档」试试。</div>}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Reasoning({ part, live, dur }: { part: RPart; live: boolean; dur?: number }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const show = open ?? live;
  return (
    <div className="rz">
      <button className="rz-head" onClick={() => setOpen(!show)}>
        <span className="chev"><Ic n={show ? 'chev-d' : 'chev-r'} s={12} /></span><Ic n="bulb" /> {live ? '思考中…' : dur ? `已思考 ${dur} 秒` : '思考过程'}
        {!show && <span className="rz-peek">{part.text.slice(-48)}</span>}
      </button>
      {show && <div className="rz-body">{part.text}</div>}
    </div>
  );
}
function ToolCard({ part, onAnswer, onOpenDoc }: { part: ToolPart; onAnswer: (id: string, v: string) => void; onOpenDoc: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(part.name);
  const state = part.output !== undefined ? (part.ok === false ? 'err' : 'ok') : part.suspended ? 'wait' : part.answered ? 'ok' : 'run';
  const label = { ok: '完成', err: '失败', wait: '等你回答', run: meta.running }[state];
  return (
    <div className="tool">
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="chev"><Ic n={open ? 'chev-d' : 'chev-r'} s={12} /></span>
        <Ic n={meta.icon} s={13} />
        <span className="tlabel">{meta.label}</span>
        <span className="tsum">{toolSummary(part)}</span>
        <span className={`tstate ${state}`}>{state === 'run' && <span className="spin" />}{label}</span>
      </button>
      {open && <ToolDetail part={part} onOpenDoc={onOpenDoc} />}
      {part.suspended && (
        <div className="ask">
          <div className="q">{part.suspended.question}</div>
          {(part.suspended.options ?? []).map(o => <button key={o} onClick={() => onAnswer(part.id, o)}>{o}</button>)}
          <FreeAnswer onSubmit={v => onAnswer(part.id, v)} />
        </div>
      )}
      {part.answered && <div className="answered"><Ic n="check" s={12} /> {part.answered}</div>}
    </div>
  );
}
function ToolDetail({ part, onOpenDoc }: { part: ToolPart; onOpenDoc: (id: string) => void }) {
  const inp: any = part.input ?? {}; const out: any = part.output;
  if (part.preparing) return <div className="tool-body dim">内容生成中,请稍候…</div>;
  if (part.name === 'web_search') {
    return (
      <div className="tool-body">
        <div className="kv"><span>搜索词</span>{String(inp.query ?? '')}</div>
        {Array.isArray(out?.results) && out.results.length > 0 && (
          <div className="reslist">{out.results.slice(0, 5).map((r: any, i: number) => (
            <a key={i} className="res" href={r.url} target="_blank" rel="noreferrer">
              <span className="res-t">{r.title || r.url}</span>
              <span className="res-d"><Ic n="globe" s={10} /> {hostOf(r.url)}</span>
            </a>))}</div>
        )}
        {out && !(Array.isArray(out.results) && out.results.length) && <div className="dim">没有拿到结果</div>}
      </div>
    );
  }
  if (part.name === 'write_document') {
    return (
      <div className="tool-body">
        {inp.title !== undefined && <div className="kv"><span>标题</span>{String(inp.title)}</div>}
        {typeof inp.content === 'string' && <div className="kv"><span>篇幅</span>约 {inp.content.length} 字</div>}
        {out?.artifact_id && <button className="ghost sm" onClick={() => onOpenDoc(String(out.artifact_id))}><Ic n="file" s={12} /> 在面板中查看</button>}
      </div>
    );
  }
  return (
    <div className="tool-body">
      {Object.entries(inp).slice(0, 6).map(([k, v]) => (
        <div className="kv" key={k}><span>{k}</span>{String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 120)}</div>
      ))}
      {out !== undefined && <div className="kv"><span>结果</span>{String(typeof out === 'object' ? JSON.stringify(out) : out).slice(0, 200)}</div>}
    </div>
  );
}
function FreeAnswer({ onSubmit }: { onSubmit: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="free">
      <input value={v} onChange={e => setV(e.target.value)} placeholder="或自由输入…"
             onKeyDown={e => e.key === 'Enter' && v.trim() && onSubmit(v)} />
    </div>
  );
}
