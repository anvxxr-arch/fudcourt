/**
 * l2.ts — the Valkey L2 JSON blob cache, shared by every layer.
 *
 * Split out of `server/cache.ts` so a feature module (the ticker sweep cache)
 * can reach the L2 without depending on `server/` — the structure gate forbids
 * features -> server, and `lib/` is the shared-infra layer both may import.
 * `server/cache.ts` re-exports these two so its existing importers are
 * unchanged.
 *
 * Fail-open by construction: a miss, a connection error, or unparseable JSON
 * all resolve to null / no-op. The caller then does the work it would have
 * done anyway; no path here may throw.
 */
import type { RedisClient } from 'bun';
/**
 * The Bun global, narrowed once. `import { RedisClient } from 'bun'`
 * type-checks and works at runtime under `bun --bun`, but Next collects page
 * data for static routes (sitemap, robots) inside a Node worker, where no
 * `bun` module exists — the build failed with "Cannot find module 'bun'"
 * while collecting /api/coins. Both runtimes expose the global, so it is
 * looked up at call time; the type comes from the erased type-only import.
 */
type BunWithRedis = { RedisClient?: new (url: string) => RedisClient };
function bunGlobal(): BunWithRedis | undefined {
  const candidate: unknown = (globalThis as { Bun?: unknown }).Bun;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  return candidate as BunWithRedis;
}
const URL = process.env.FUDCOURT_VALKEY_URL || '';
let client: RedisClient | null = null;
let disabled = false;
function conn(): RedisClient | null {
  if (disabled || !URL) return null;
  if (!client) {
    const RedisCtor = bunGlobal()?.RedisClient;
    if (!RedisCtor) {
      disabled = true;
      return null;
    }
    try {
      client = new RedisCtor(URL);
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
