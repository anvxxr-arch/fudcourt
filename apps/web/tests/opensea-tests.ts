/**
 * The OpenSea connection — the part that must hold with no network at all.
 *
 * The live reads themselves are proven by invocation against the real API (the
 * contract/account NFT reads, the keyless collection reads, the status mapping
 * in the route). What is pinned here is the failure CLASS this repo has already
 * paid for once: an endpoint that fails must never present as a confident empty
 * result. `/api/wallets` answered 500 while the surface rendered `Wallets (0)`,
 * and a missing OpenSea key would read exactly the same way — "this wallet owns
 * no NFTs" — if the guard were not explicit. These assertions are deterministic
 * and offline, so they cannot flake the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENSEA_BASE,
  OPENSEA_CHAINS_TTL_MS,
  OPENSEA_EVENT_TYPES,
  OPENSEA_FLOOR_TIMEFRAMES,
  OPENSEA_SEARCH_ASSET_TYPES,
  OPENSEA_STATS_TTL_MS,
  OPENSEA_TOP_SORTS,
  OPENSEA_TRENDING_TIMEFRAMES,
  OPENSEA_TTL_MS,
  OpenSeaError,
  accountCollections,
  accountNfts,
  accountPortfolio,
  bestListing,
  bestOffer,
  clampLimit,
  collectionEvents,
  collectionNfts,
  contractNfts,
  floorPrices,
  getNFT,
  openseaHeaders,
  openseaKey,
  searchOpenSea,
  topCollections,
  traitFloors,
  trendingCollections,
} from '@/features/nft/opensea';

test('OpenSea: the base URL is the v2 API and the TTL is a minute', () => {
  assert.equal(OPENSEA_BASE, 'https://api.opensea.io/api/v2');
  assert.equal(OPENSEA_TTL_MS, 60_000);
});

test('OpenSea: clampLimit clamps to 1..50 and falls back on a non-number', () => {
  assert.equal(clampLimit(999), 50, 'above the ceiling clamps down');
  assert.equal(clampLimit(0), 1, 'zero clamps up');
  assert.equal(clampLimit(-3), 1, 'negative clamps up');
  assert.equal(clampLimit(7), 7, 'in range is untouched');
  assert.equal(clampLimit('x'), 20, 'a non-number takes the default');
  assert.equal(clampLimit(undefined), 20, 'undefined takes the default');
  assert.equal(clampLimit('12'), 12, 'a numeric string is honoured');
});

test('OpenSea: the key rides on the headers only when one is configured', () => {
  assert.ok(Object.keys(openseaHeaders('probe-key')).includes('X-API-KEY'));
  assert.ok(!Object.keys(openseaHeaders(null)).includes('X-API-KEY'));
  assert.ok(!Object.keys(openseaHeaders('')).includes('X-API-KEY'));
});

test('OpenSea: a keyed read without a credential throws missing-key, never an empty result', async () => {
  const saved = process.env.OPENSEA_API_KEY;
  delete process.env.OPENSEA_API_KEY;
  try {
    assert.equal(openseaKey(), null, 'the key reads as absent');

    // Both keyed readers, so the guard cannot be present on only one of them.
    for (const call of [contractNfts('ethereum', '0x0'), accountNfts('ethereum', '0x0')]) {
      let caught: unknown;
      try {
        await call;
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof OpenSeaError, 'threw an OpenSeaError');
      assert.equal((caught as OpenSeaError).kind, 'missing-key');
      assert.equal((caught as OpenSeaError).status, 0, 'no HTTP status: no request was made');
      assert.match((caught as OpenSeaError).message, /OPENSEA_API_KEY/, 'the message names the variable');
    }
  } finally {
    if (saved !== undefined) process.env.OPENSEA_API_KEY = saved;
  }
});

test('OpenSea: per-family TTLs pace trading figures faster than static metadata', () => {
  assert.equal(OPENSEA_TTL_MS, 60_000, 'collection/NFT detail: a minute');
  assert.equal(OPENSEA_STATS_TTL_MS, 30_000, 'stats/floors/orders: thirty seconds');
  assert.equal(OPENSEA_CHAINS_TTL_MS, 3_600_000, 'chain list: an hour');
  assert.ok(OPENSEA_STATS_TTL_MS < OPENSEA_TTL_MS, 'trading figures refresh faster');
  assert.ok(OPENSEA_TTL_MS < OPENSEA_CHAINS_TTL_MS, 'static metadata refreshes slowest');
});

test('OpenSea: every keyed reader throws missing-key without a credential, never an empty result', async () => {
  const saved = process.env.OPENSEA_API_KEY;
  delete process.env.OPENSEA_API_KEY;
  try {
    assert.equal(openseaKey(), null, 'the key reads as absent');

    // Every needsKey=true reader, so the guard cannot be present on only some.
    const calls = [
      contractNfts('ethereum', '0x0'),
      accountNfts('ethereum', '0x0'),
      getNFT('ethereum', '0x0', '1'),
      collectionNfts('doodles-official'),
      traitFloors('doodles-official'),
      floorPrices('doodles-official'),
      bestListing('doodles-official', '1'),
      bestOffer('doodles-official', '1'),
      accountPortfolio('0x0'),
      accountCollections('0x0'),
      trendingCollections(1),
      topCollections(1),
      collectionEvents('doodles-official'),
      searchOpenSea('doodle', 1),
    ];
    assert.equal(calls.length, 14, 'all fourteen keyed readers guarded');
    for (const call of calls) {
      let caught: unknown;
      try {
        await call;
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof OpenSeaError, 'threw an OpenSeaError');
      assert.equal((caught as OpenSeaError).kind, 'missing-key');
      assert.equal((caught as OpenSeaError).status, 0, 'no HTTP status: no request was made');
      assert.match((caught as OpenSeaError).message, /OPENSEA_API_KEY/, 'the message names the variable');
    }
  } finally {
    if (saved !== undefined) process.env.OPENSEA_API_KEY = saved;
  }
});

test('OpenSea: a throttled deployment surfaces as rate-limited with the upstream status', () => {
  const e = new OpenSeaError('rate-limited', 'OpenSea throttled this deployment (429)', 429);
  assert.equal(e.kind, 'rate-limited');
  assert.equal(e.status, 429, 'the 429 survives, so the route can answer 429');
  assert.equal(e.name, 'OpenSeaError');
});

test('OpenSea: venue vocabularies are pinned so the route and client cannot drift', () => {
  assert.ok(OPENSEA_TRENDING_TIMEFRAMES.includes('one_day'), 'trending has one_day');
  assert.ok(OPENSEA_FLOOR_TIMEFRAMES.includes('one_day'), 'floor history has one_day');
  assert.ok(OPENSEA_TOP_SORTS.includes('one_day_volume'), 'top sorts by one_day_volume');
  assert.ok(OPENSEA_EVENT_TYPES.includes('sale'), 'events has sale');
  assert.ok(OPENSEA_SEARCH_ASSET_TYPES.includes('collection'), 'search has collection');
  assert.equal(OPENSEA_TRENDING_TIMEFRAMES.length, 9, 'trending vocab size pinned');
  assert.equal(OPENSEA_TOP_SORTS.length, 9, 'top vocab size pinned');
  assert.equal(OPENSEA_EVENT_TYPES.length, 7, 'event vocab size pinned');
});
