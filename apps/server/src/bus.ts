/** 进程内事件总线:SSE 的实时投影通道(日志才是真相,bus 只是转播)。 */
import { EventEmitter } from 'node:events';
import type { Chunk } from '../../../packages/protocol/src/index.js';

class Bus {
  private ee = new EventEmitter();
  constructor() { this.ee.setMaxListeners(1000); }
  emit(threadId: string, chunk: Chunk) { this.ee.emit(threadId, chunk); }
  subscribe(threadId: string, fn: (c: Chunk) => void): () => void {
    this.ee.on(threadId, fn);
    return () => this.ee.off(threadId, fn);
  }
}
export const bus = new Bus();
