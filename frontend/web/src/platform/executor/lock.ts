/**
 * lock.ts — Valkey execution locks (PRD §65): one worker owns one execution at
 * a time, so a worker race can never double-submit orders.
 *
 * Key: `execution:{executionId}:lock`, value: owner token `${workerId}:${random}`
 * so a delayed worker cannot release a lease it already lost. Acquisition is
 * `SET key val NX PX ttl`; release/heartbeat compare-and-act atomically via Lua
 * (the only correct way — GET-then-DEL races another owner's acquisition).
 *
 * FAIL-CLOSED, unlike the JSON cache in platform/cache/valkey.ts: a lock that
 * fails open means duplicate orders, so any Valkey error or a missing/unusable
 * client makes `acquire` resolve false (the caller must not trade) and
 * `heartbeat` false (the caller has lost its lease). Only `release` is best
 * effort — there is nothing to lose.
 */
import type { RedisClient } from 'bun';
import type { ExecutionLock } from '@/platform/executor/types';

/**
 * The slice of Bun's RedisClient used here. `eval` exists on the real client
 * (bun-types redis.d.ts) but the fake in the tests implements just this.
 */
export interface LockClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numkeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
}
/**
 * Resolve the client class off the global instead of importing it: `bun` does
 * not exist inside the Node worker Next uses to collect static routes, but the
 * global does (same lazy-global pattern as platform/cache/valkey.ts).
 */
const BunGlobal = (globalThis as { Bun?: { RedisClient?: new (url: string) => RedisClient } }).Bun;
const URL = process.env.FUDCOURT_VALKEY_URL || '';
let injected: LockClient | null = null;
let client: LockClient | null = null;
// Once unusable (no URL, no class, construction failure) stay disabled rather
// than re-throwing on every call — but every call still answers FAIL-CLOSED.
let disabled = false;
/** Test seam: drive lock semantics with a fake (records SET NX PX + Lua). */
export function setLockClientForTests(fake: LockClient | null): void {
  injected = fake;
  if (fake) disabled = false;
}
/** Test seam: drop the lazy client so a reconfigured environment starts fresh. */
export function resetLockClientForTests(): void {
  injected = null;
  client = null;
  disabled = false;
}
function conn(): LockClient | null {
  if (injected) return injected;
  if (disabled || !URL) return null;
  if (!client) {
    try {
      if (!BunGlobal?.RedisClient) {
        disabled = true;
        return null;
      }
      // Bun's SET NX PX matches the interface exactly; the class comes from
      // `bun`, so the interface is the checked contract (bypass reason: the
      // global lookup cannot carry the class's full structural type).
      client = new BunGlobal.RedisClient(URL) as unknown as LockClient;
    } catch (e) {
      disabled = true;
      console.error(`lock: Valkey client construction failed (${(e as Error).message}) — execution locks unavailable (fail-closed)`);
    }
  }
  return client;
}
/** Lock key format (PRD §65). */
export function lockKey(executionId: string): string {
  return `execution:${executionId}:lock`;
}
// Owner token: workerId + a fresh random suffix per acquire attempt, so two
// acquires by the "same" worker (after an expiry) never alias one lease.
const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const HEARTBEAT_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
// The owner token is minted at acquire (it must be random per attempt) and the
// ExecutionLock interface passes only workerId afterwards, so the mapping from
// (executionId, workerId) to the held token lives here — in-process only, lost
// on restart, which is correct: a restarted worker must re-acquire (PRD §114).
const tokens = new Map<string, string>();

export const executionLock: ExecutionLock = {
  /** Try to take the lease. Any failure is "not acquired" — never true. */
  async acquire(executionId: string, workerId: string, ttlMs: number): Promise<boolean> {
    const c = conn();
    if (!c) return false;
    try {
      const token = `${workerId}:${Math.random().toString(36).slice(2, 12)}`;
      const res = await c.set(lockKey(executionId), token, 'PX', Math.max(1, Math.round(ttlMs)), 'NX');
      if (res !== 'OK') return false;
      tokens.set(`${executionId}\n${workerId}`, token);
      return true;
    } catch (e) {
      console.error(`lock: acquire ${executionId} failed (${(e as Error).message}) — fail-closed`);
      return false;
    }
  },
  /** Owner-token release: releasing someone else's lease is a no-op. */
  async release(executionId: string, workerId: string): Promise<void> {
    const c = conn();
    const token = tokens.get(`${executionId}\n${workerId}`);
    if (!c || token === undefined) return;
    try {
      await c.eval(RELEASE_LUA, 1, lockKey(executionId), token);
    } catch (e) {
      console.error(`lock: release ${executionId} failed (${(e as Error).message})`);
    } finally {
      tokens.delete(`${executionId}\n${workerId}`);
    }
  },
  /** Extend the lease; false = lease lost (expired or someone else's). */
  async heartbeat(executionId: string, workerId: string, ttlMs: number): Promise<boolean> {
    const c = conn();
    const token = tokens.get(`${executionId}\n${workerId}`);
    if (!c || token === undefined) return false;
    try {
      const res = await c.eval(HEARTBEAT_LUA, 1, lockKey(executionId), token, Math.max(1, Math.round(ttlMs)));
      return res === 1;
    } catch (e) {
      console.error(`lock: heartbeat ${executionId} failed (${(e as Error).message}) — fail-closed`);
      return false;
    }
  },
};
