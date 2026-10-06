/**
 * Valkey L2 for the web tier (DR-019).
 *
 * Most families reach local Postgres or their own upstream cache; this exists for
 * the one thing that is neither: the exchange venue sweep, which costs ~64 s on a
 * cold process and is currently re-paid on every restart and deploy. That sweep
 * lives in module state (`sweepCache` in features/ticker/client.ts), so a restart
 * throws it away — and 64 s of cold latency is the worst case in the whole app.
 *
 * It is a JSON blob cache, FAIL-OPEN, and off unless FUDCOURT_VALKEY_URL is set:
 *
 *   FUDCOURT_VALKEY_URL=redis://:password@127.0.0.1:6379
 *
 * Bun's native Redis client is used rather than a new dependency: the web process
 * already runs under `bun --bun` (the systemd unit), so this is a builtin.
 *
 * A cache miss, a connection error, or unparseable JSON all resolve to null. The
 * caller then does the work it would have done anyway; no path here may throw.
 */
import 'server-only';
import type { RedisClient } from 'bun';

/**
 * Resolve the client class off the global instead of importing it.
 *
 * `import { RedisClient } from 'bun'` type-checks and works at runtime under
 * `bun --bun`, but Next collects page data for static routes (sitemap, robots)
 * inside a Node worker, where no `bun` module exists — the build failed with
 * "Cannot find module 'bun'" evaluating the sitemap. The global is present in
 * both, so this is a runtime lookup with the type coming from the (erased)
 * type-only import.
 */
const BunGlobal = (globalThis as { Bun?: { RedisClient?: new (url: string) => RedisClient } }).Bun;

const URL = process.env.FUDCOURT_VALKEY_URL || '';

let client: RedisClient | null = null;
let disabled = false;

function conn(): RedisClient | null {
  if (disabled || !URL) return null;
  if (!client) {
    try {
      if (!BunGlobal?.RedisClient) {
        disabled = true;
        return null;
      }
      client = new BunGlobal.RedisClient(URL);
    } catch (e) {
      disabled = true;
      console.error(`cache: Valkey client construction failed (${(e as Error).message}) — continuing without it`);
    }
  }
  return client;
}

/** Read and parse a cached JSON value. Any failure is a miss (null). */
export async function l2GetJson<T>(key: string): Promise<T | null> {
  const c = conn();
  if (!c) return null;
  try {
    const raw = await c.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`cache: get ${key} failed: ${(e as Error).message}`);
    return null;
  }
}

/** Store a JSON value. A failure is logged and swallowed. */
export async function l2SetJson(key: string, value: unknown, ttlMs: number): Promise<void> {
  const c = conn();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), 'PX', Math.max(1, Math.round(ttlMs)));
  } catch (e) {
    console.error(`cache: set ${key} failed: ${(e as Error).message}`);
  }
}
