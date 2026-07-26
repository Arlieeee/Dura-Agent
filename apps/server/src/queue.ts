/** 执行分发:inline(零依赖,进程内直跑)或 bullmq(Redis 队列,可 kill 演练/水平扩容)。
 * 常见做法是"首段进程内直跑保延迟,长工作交队列"—— 这里简化为整个 turn 二选一。 */
import type { RunnerDeps } from './engine/runner.js';
import { runTurn } from './engine/runner.js';

export interface Dispatcher { kick(threadId: string, turnId: string, attempt?: number): Promise<void>; close(): Promise<void> }

class InlineDispatcher implements Dispatcher {
  private timers = new Set<NodeJS.Timeout>();
  constructor(private deps: RunnerDeps) {}
  async kick(threadId: string, turnId: string, attempt = 0) {
    // 不 await:HTTP 返回 SSE 流,runner 后台推进(与连接解耦)
    runTurn(this.deps, threadId, turnId).catch(err => {
      // runner 只在"可重试且未超上限"时抛;超上限它自己写 turn.finished 并正常返回。
      // 所以这里收到异常 = 该退避重投。inline 没有队列,退避靠定时器自己扛。
      console.error(`[runner] turn ${turnId} 抛出,${1 << attempt}s 后重投:`, err?.message ?? err);
      const t = setTimeout(() => { this.timers.delete(t); void this.kick(threadId, turnId, attempt + 1); }, (1 << attempt) * 1000);
      t.unref?.();
      this.timers.add(t);
    });
  }
  async close() { for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
}

class BullDispatcher implements Dispatcher {
  private queue: any; private worker: any; private sweeper: NodeJS.Timeout;
  private constructor(queue: any, worker: any, deps: RunnerDeps) {
    this.queue = queue; this.worker = worker;
    // sweeper:心跳超时的 running/pending turn → 重投(kill -9 后由此恢复;确定性事件 ID 保证重跑幂等)
    this.sweeper = setInterval(async () => {
      for (const t of await deps.store.staleTurns(15_000)) {
        console.log(`[sweeper] turn ${t.id}(${t.state})心跳丢失 → 重投`);
        await deps.store.upsertTurn({ id: t.id, thread_id: t.thread_id, heartbeat_at: Date.now() });   // 防同一 turn 连续重投
        await this.kick(t.thread_id, t.id).catch((e: any) => console.error('[sweeper] 重投失败:', e?.message));
      }
    }, 5_000);
  }
  static async create(deps: RunnerDeps): Promise<BullDispatcher> {
    const { Queue, Worker } = await import('bullmq');
    // BullMQ 的 connection 透传给 ioredis,`{ url }` 不是合法字段(会静默连到默认 127.0.0.1)——必须用 ioredis 实例
    const { Redis } = await import('ioredis');
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    const queue = new Queue('turns', { connection });
    const worker = new Worker('turns',
      async (job: any) => runTurn(deps, job.data.threadId, job.data.turnId),
      { connection, concurrency: 4 });
    worker.on('failed', (job: any, err: Error) => console.error(`[worker] job ${job?.id} 失败(将重试):`, err.message));
    return new BullDispatcher(queue, worker, deps);
  }
  async kick(threadId: string, turnId: string) {
    // jobId = turnId:同一 turn 在队列里最多一个 job(add 同 id 自动忽略)= turn 级并发互斥。
    // 完成/失败即移除占位,后续重投可再入。注意 jobId 不允许含冒号(BullMQ 会抛错)。
    await this.queue.add('turn', { threadId, turnId }, {
      jobId: turnId, attempts: 3, backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true, removeOnFail: true,
    });
  }
  async close() { clearInterval(this.sweeper); await this.worker.close(); await this.queue.close(); }
}

export async function makeDispatcher(deps: RunnerDeps): Promise<Dispatcher> {
  if ((process.env.RUNNER_MODE ?? 'inline') === 'bullmq') {
    console.log('[queue] BullMQ 模式(Redis)');
    return BullDispatcher.create(deps);
  }
  console.log('[queue] inline 模式(零依赖;生产配 RUNNER_MODE=bullmq)');
  return new InlineDispatcher(deps);
}
