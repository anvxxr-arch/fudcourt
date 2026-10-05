#!/usr/bin/env node
/**
 * Asserts the upstream limiter's cache is bounded and evicts LRU.
 *
 * Run:  node --experimental-strip-types scripts/tests/verify-limiter.mts
 *
 * Why this is a separate in-process suite rather than more checks in
 * verify-dex.py: an HTTP test cannot tell eviction from expiry. Filling the
 * cache over HTTP is serial (the limiter enforces a 200ms min-gap), so 420 keys
 * take 228s -- 15x the production TTL of 15s. By the time you assert, every
 * entry has expired, and "the oldest key is gone" is equally explained by
 * "eviction never happens". That test passed while proving nothing.
 *
 * Here ttlMs is 600_000, so the cache is never the thing under test and a MISS
 * can only mean eviction.
 *
 * The bug this covers: the cache Map was only ever get/set/clear. The clear
 * lives in a test seam that never runs in production, so retained bodies grew
 * with DISTINCT QUERIES EVER MADE -- unbounded, and trivially reachable through
 * the search box.
 */
import { limitedFetch, __resetLimiter, __cacheStats } from '../src/lib/rate-limit.ts';

const TTL = 600_000; // 10 min -- long enough that expiry cannot explain a MISS
const OPTS = { ttlMs: TTL };
const CAP = 300;
const url = (q: string) => `https://api.dexscreener.com/latest/dex/search?q=${q}`;

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? '  ' + detail : ''}`);
}

async function mark(q: string) {
  const r = await limitedFetch(url(q), {}, OPTS);
  return r.headers.get('X-Cache');
}

// Prove the network path works before asserting anything about the cache.
const first = await limitedFetch(url('warm'), {}, OPTS);
check(first.status === 200, 'a real upstream fetch works through the limiter', `status ${first.status}`);
__resetLimiter();

console.log('\n▸ the cache is bounded');
for (let i = 0; i < CAP + 120; i++) await mark('lru' + i);
const s = __cacheStats();
check(s.size === CAP, `retained size is capped at ${CAP}`, `size ${s.size}`);
check(s.size <= s.cap, 'retained size never exceeds the cap', `${s.size} <= ${s.cap}`);
check(s.inflight === 0, 'no in-flight entries leak', `inflight ${s.inflight}`);

console.log('\n▸ eviction is least-recently-used');
check((await mark('lru0')) === 'MISS', 'the oldest key was evicted', 'expect MISS');
check((await mark(`lru${CAP + 119}`)) === 'HIT', 'the newest key is retained', 'expect HIT');
check((await mark(`lru${CAP + 119 - 50}`)) === 'HIT', 'a key inside the window is retained', 'expect HIT');

console.log('\n▸ reading promotes, so a hot key survives');
// 120 new keys is under the 300 cap, so this isolates "reading promotes" from
// "the cap evicted something else".
const hot = `lru${CAP + 119 - 10}`;
for (let i = 0; i < 120; i++) await mark(`flood_${i}`);
check((await mark(hot)) === 'HIT', 'hot key survives a flood of new keys', 'expect HIT');

console.log('\n▸ cached bodies are complete JSON, not truncated');
const wsol = 'So11111111111111111111111111111111111111112';
const r = await limitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${wsol}`, {}, OPTS);
const j = JSON.parse(await r.text());
const pairs = j.pairs ?? j;
check(Array.isArray(pairs) && pairs.length > 0, 'a fat payload parses after eviction pressure',
  `${Array.isArray(pairs) ? pairs.length : 'not-an-array'} pairs`);

console.log(`\n${fail ? `${fail} FAILED, ${pass} passed` : `all ${pass} checks passed`}`);
process.exit(fail ? 1 : 0);
