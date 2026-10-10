/**
 * The chain-slug mapping — the boundary that keeps a guessed chain name from
 * becoming a UI bug. Offline and deterministic; the live reads that justify the
 * two measured slugs are recorded in the module itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENSEA_CHAINS, chainSlug } from '@/lib/opensea-chains';

test('OpenSea chains: the chains this app actually stores resolve', () => {
  // Measured live, by address: ?chain=bsc -> 200 with real NFTs, ?chain=solana -> 200.
  assert.equal(chainSlug('BSC'), 'bsc');
  assert.equal(chainSlug('Solana'), 'solana');
  assert.equal(chainSlug('bsc'), 'bsc');
  assert.equal(chainSlug('  Solana '), 'solana');
});

test('OpenSea chains: a wrong NAME does not fold into a slug — the bnb counter-proof', () => {
  // 'bnb' is the plausible guess, and OpenSea answers 400 "Unrecognized chain:
  // bnb". Membership in the measured list — not case-folding — is what keeps it
  // out, so this test is the guard on the guard.
  assert.equal(chainSlug('bnb'), null);
  assert.equal(chainSlug('BNB'), null);
  assert.equal(chainSlug('BNB Chain'), null);
  assert.ok(!(OPENSEA_CHAINS as readonly string[]).includes('bnb'));
});

test('OpenSea chains: an unresolved chain is reported as null, never invented', () => {
  for (const unresolved of ['', '   ', null, undefined, 'Ethereum Mainnet', 'Solana Devnet']) {
    assert.equal(chainSlug(unresolved), null, `chainSlug(${JSON.stringify(unresolved)}) must be null`);
  }
});

test('OpenSea chains: the list is lowercase and unique, and carries the two measured slugs', () => {
  assert.equal(new Set(OPENSEA_CHAINS).size, OPENSEA_CHAINS.length, 'no duplicates');
  for (const c of OPENSEA_CHAINS) assert.equal(c, c.toLowerCase(), `${c} must be lowercase`);
  assert.ok((OPENSEA_CHAINS as readonly string[]).includes('bsc'), 'bsc (the wallets table stores BSC)');
  assert.ok((OPENSEA_CHAINS as readonly string[]).includes('solana'), 'solana (the wallets table stores Solana)');
});
