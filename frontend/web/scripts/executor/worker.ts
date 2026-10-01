/**
 * worker.ts — the executor worker's composition root (PRD §68, §100).
 *
 * Run by `fudcourt-executor-worker.service` under Bun:
 *   /home/dwizzy/.bun/bin/bun scripts/executor/worker.ts
 *
 * It is deliberately the ONLY place that knows how an execution row becomes a
 * live venue connection: the worker core holds no credential handling (§102),
 * and the store's `revealCredentials` is the only plaintext path (§44). The
 * scheduler runs here — independent of any browser (§67): closing the tab never
 * stops an execution.
 *
 * Fail-closed boots (all loud, none silent):
 *  - no FUDCOURT_EXECUTOR_MASTER_KEY  → credential ops throw (store) → exit 1
 *  - no FUDCOURT_PG_URL               → executor schema cannot be ensured → exit 1
 *  - FUDCOURT_EXECUTOR_LIVE unset     → LIVE placements pause at the boundary
 *    (the kill switch of §108); paper and reconciliation keep running.
 */
import { hostname } from 'node:os';
import { store } from '@/platform/executor/store';
import { executionLock } from '@/platform/executor/lock';
import { createWorker } from '@/platform/executor/worker';
import { bootstrapExecutor } from '@/platform/executor/runtime';

async function main(): Promise<void> {
  // One composition path for API and worker (schema + adapter factory).
  await bootstrapExecutor();

  const workerId = process.env.FUDCOURT_EXECUTOR_WORKER_ID ?? `${hostname()}-${process.pid}`;
  const worker = createWorker({
    store,
    lock: executionLock,
    workerId,
  });
  await worker.start();
  console.error(`executor-worker: started as ${workerId} (live=${process.env.FUDCOURT_EXECUTOR_LIVE === '1' ? 'enabled' : 'kill-switched'})`);

  // Graceful stop: SIGINT is what the unit sends (KillSignal=SIGINT, DR-008's
  // parity choice) — a held execution lease expires on its TTL regardless (§65).
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.error(`executor-worker: ${signal} — stopping scheduler`);
    await worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(`executor-worker: fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
