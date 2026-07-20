/** 事件存储:唯一真相。Memory(零依赖开发)与 Postgres(生产)双实现。 */
import { createHash } from 'node:crypto';
import type { AgentEvent } from '../../../packages/protocol/src/index.js';

export interface TurnRow {
  id: string; thread_id: string; state: 'pending' | 'running' | 'suspended' | 'completed' | 'failed';
  heartbeat_at: number; created_at: string;
}
export interface ThreadRow { id: string; title: string; user_id: string; created_at: string; updated_at: string }
export interface UserRow { id: string; username: string; pass_hash: string; created_at: string }
export interface ArtifactRow { id: string; thread_id: string; title: string; kind: string; content: string; created_at: string }

export interface EventStore {
  append(evt: AgentEvent): Promise<boolean>;
  load(threadId: string): Promise<AgentEvent[]>;
  createThread(id: string, title: string, userId: string): Promise<void>;
  getThread(id: string): Promise<ThreadRow | null>;
  listThreads(userId: string): Promise<ThreadRow[]>;
  setThreadTitle(id: string, title: string): Promise<void>;
  touchThread(id: string): Promise<void>;
  createUser(u: UserRow): Promise<void>;
  getUserByName(username: string): Promise<UserRow | null>;
  getUser(id: string): Promise<UserRow | null>;
  updateUserPassHash(id: string, passHash: string): Promise<void>;
  upsertTurn(t: Partial<TurnRow> & { id: string; thread_id: string }): Promise<void>;
  getTurn(id: string): Promise<TurnRow | null>;
  staleTurns(olderThanMs: number): Promise<TurnRow[]>;
  putArtifact(a: ArtifactRow): Promise<void>;
  getArtifact(id: string): Promise<ArtifactRow | null>;
  listArtifacts(threadId: string): Promise<ArtifactRow[]>;
}

/** 确定性事件 ID:同一 turn 内容重写 = no-op(收敛式重跑的根基) */
export function eventId(turnId: string, kind: string, key: string): string {
  return 'ev_' + createHash('sha1').update(`${turnId}|${kind}|${key}`).digest('hex').slice(0, 16);
}

/* ================= Memory 实现 ================= */
export class MemoryStore implements EventStore {
  private events = new Map<string, AgentEvent[]>();
  private ids = new Set<string>();
  private threads = new Map<string, ThreadRow>();
  private users = new Map<string, UserRow>();
  private turns = new Map<string, TurnRow>();
  private artifacts = new Map<string, ArtifactRow>();
  private seq = 0;

  async append(evt: AgentEvent) {
    if (this.ids.has(evt.id)) return false;
    this.ids.add(evt.id);
    const row = { ...evt, seq: ++this.seq, created_at: new Date().toISOString() };
    if (!this.events.has(evt.thread_id)) this.events.set(evt.thread_id, []);
    this.events.get(evt.thread_id)!.push(row);
    return true;
  }
  async load(threadId: string) { return [...(this.events.get(threadId) ?? [])]; }
  async createThread(id: string, title: string, userId: string) {
    const now = new Date().toISOString();
    this.threads.set(id, { id, title, user_id: userId, created_at: now, updated_at: now });
  }
  async getThread(id: string) { return this.threads.get(id) ?? null; }
  async listThreads(userId: string) {
    return [...this.threads.values()].filter(t => t.user_id === userId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async setThreadTitle(id: string, title: string) { const t = this.threads.get(id); if (t) t.title = title; }
  async touchThread(id: string) { const t = this.threads.get(id); if (t) t.updated_at = new Date().toISOString(); }
  async createUser(u: UserRow) { this.users.set(u.id, u); }
  async getUserByName(username: string) { return [...this.users.values()].find(u => u.username === username) ?? null; }
  async getUser(id: string) { return this.users.get(id) ?? null; }
  async updateUserPassHash(id: string, passHash: string) { const u = this.users.get(id); if (u) u.pass_hash = passHash; }
  async upsertTurn(t: Partial<TurnRow> & { id: string; thread_id: string }) {
    const prev = this.turns.get(t.id) ?? { id: t.id, thread_id: t.thread_id, state: 'pending' as const, heartbeat_at: Date.now(), created_at: new Date().toISOString() };
    this.turns.set(t.id, { ...prev, ...t });
  }
  async getTurn(id: string) { return this.turns.get(id) ?? null; }
  async staleTurns(olderThanMs: number) {
    const now = Date.now();
    // pending = 已受理未开跑(kick 后进程死掉会停在这);running = 跑到一半死掉。都属于「心跳丢失需重投」
    return [...this.turns.values()].filter(t => (t.state === 'running' || t.state === 'pending') && now - t.heartbeat_at > olderThanMs);
  }
  async putArtifact(a: ArtifactRow) { this.artifacts.set(a.id, a); }
  async getArtifact(id: string) { return this.artifacts.get(id) ?? null; }
  async listArtifacts(threadId: string) { return [...this.artifacts.values()].filter(a => a.thread_id === threadId); }
}

/* ================= Postgres 实现 ================= */
export class PgStore implements EventStore {
  private pool: any;
  private constructor(pool: any) { this.pool = pool; }

  static async connect(url: string): Promise<PgStore> {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    await PgStore.migrate(pool);
    return new PgStore(pool);
  }
  private static async migrate(pool: any) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_events (
        id text PRIMARY KEY, seq bigserial, thread_id text NOT NULL, turn_id text NOT NULL,
        kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT now());
      CREATE INDEX IF NOT EXISTS idx_events_thread ON agent_events (thread_id, seq);
      CREATE TABLE IF NOT EXISTS threads (id text PRIMARY KEY, title text DEFAULT '', created_at timestamptz DEFAULT now());
      ALTER TABLE threads ADD COLUMN IF NOT EXISTS user_id text DEFAULT '';
      ALTER TABLE threads ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      CREATE INDEX IF NOT EXISTS idx_threads_user ON threads (user_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS users (
        id text PRIMARY KEY, username text UNIQUE NOT NULL, pass_hash text NOT NULL, created_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS turns (
        id text PRIMARY KEY, thread_id text NOT NULL, state text DEFAULT 'pending',
        heartbeat_at bigint DEFAULT 0, created_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS artifacts (
        id text PRIMARY KEY, thread_id text NOT NULL, title text, kind text, content text, created_at timestamptz DEFAULT now());
    `);
  }
  async append(evt: AgentEvent) {
    const r = await this.pool.query(
      `INSERT INTO agent_events (id, thread_id, turn_id, kind, payload) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [evt.id, evt.thread_id, evt.turn_id, evt.kind, JSON.stringify(evt.payload)]);
    return r.rowCount > 0;
  }
  async load(threadId: string) {
    const r = await this.pool.query(`SELECT * FROM agent_events WHERE thread_id=$1 ORDER BY seq`, [threadId]);
    return r.rows.map((x: any) => ({ ...x, seq: Number(x.seq) }));
  }
  async createThread(id: string, title: string, userId: string) {
    await this.pool.query(`INSERT INTO threads (id, title, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, title, userId]);
  }
  async getThread(id: string) { return (await this.pool.query(`SELECT * FROM threads WHERE id=$1`, [id])).rows[0] ?? null; }
  async listThreads(userId: string) {
    return (await this.pool.query(`SELECT * FROM threads WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100`, [userId])).rows;
  }
  async setThreadTitle(id: string, title: string) {
    await this.pool.query(`UPDATE threads SET title=$2 WHERE id=$1`, [id, title]);
  }
  async touchThread(id: string) {
    await this.pool.query(`UPDATE threads SET updated_at=now() WHERE id=$1`, [id]);
  }
  async createUser(u: UserRow) {
    await this.pool.query(`INSERT INTO users (id, username, pass_hash) VALUES ($1,$2,$3)`, [u.id, u.username, u.pass_hash]);
  }
  async getUserByName(username: string) {
    return (await this.pool.query(`SELECT * FROM users WHERE username=$1`, [username])).rows[0] ?? null;
  }
  async getUser(id: string) { return (await this.pool.query(`SELECT * FROM users WHERE id=$1`, [id])).rows[0] ?? null; }
  async updateUserPassHash(id: string, passHash: string) {
    await this.pool.query(`UPDATE users SET pass_hash=$2 WHERE id=$1`, [id, passHash]);
  }
  async upsertTurn(t: Partial<TurnRow> & { id: string; thread_id: string }) {
    await this.pool.query(
      `INSERT INTO turns (id, thread_id, state, heartbeat_at) VALUES ($1,$2,COALESCE($3,'pending'),$4)
       ON CONFLICT (id) DO UPDATE SET state=COALESCE($3, turns.state), heartbeat_at=$4`,
      [t.id, t.thread_id, t.state ?? null, t.heartbeat_at ?? Date.now()]);
  }
  async getTurn(id: string) { return (await this.pool.query(`SELECT * FROM turns WHERE id=$1`, [id])).rows[0] ?? null; }
  async staleTurns(olderThanMs: number) {
    const r = await this.pool.query(
      `SELECT * FROM turns WHERE state IN ('running','pending') AND heartbeat_at < $1`, [Date.now() - olderThanMs]);
    return r.rows.map((x: any) => ({ ...x, heartbeat_at: Number(x.heartbeat_at) }));
  }
  async putArtifact(a: ArtifactRow) {
    await this.pool.query(`INSERT INTO artifacts (id, thread_id, title, kind, content) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [a.id, a.thread_id, a.title, a.kind, a.content]);
  }
  async getArtifact(id: string) { return (await this.pool.query(`SELECT * FROM artifacts WHERE id=$1`, [id])).rows[0] ?? null; }
  async listArtifacts(threadId: string) {
    return (await this.pool.query(`SELECT * FROM artifacts WHERE thread_id=$1 ORDER BY created_at`, [threadId])).rows;
  }
}

export async function makeStore(): Promise<EventStore> {
  if (process.env.DATABASE_URL) {
    console.log('[store] Postgres 模式');
    return PgStore.connect(process.env.DATABASE_URL);
  }
  console.log('[store] Memory 模式(零依赖,重启即失;生产请配 DATABASE_URL)');
  return new MemoryStore();
}
