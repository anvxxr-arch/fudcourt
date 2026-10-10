/**
 * OpenSea's chain slugs — the ONE mapping this app is allowed to make, and its
 * exact limits.
 *
 * OpenSea addresses chains by its own slug vocabulary while `wallets.chain`
 * stores a presentation string ('BSC', 'Solana', keyed `bsc`/`solana` in the
 * `venues` dimension). Bridging those is a real mapping, so it was MEASURED
 * rather than assumed (2026-10-09):
 *
 *   ?chain=bsc    -> 200, real NFTs
 *   ?chain=bnb    -> 400 "Unrecognized chain: bnb"
 *   ?chain=solana -> 200
 *   ?chain=matic  -> 200, real NFTs — yet line below's enumeration OMITS `matic`
 *
 * Three consequences, and each one is encoded here rather than left to prose:
 *
 * 1. THE FOLD IS NOT A GUESS, BECAUSE THE RESULT MUST BE A KNOWN SLUG. Case-
 *    folding alone would turn `bnb` into a plausible slug and buy a 400; folding
 *    plus membership is what makes 'BSC' -> `bsc` safe and 'bnb' -> nothing.
 * 2. THE ENUMERATION IS A FLOOR, NOT A CEILING — AND OPENSEA'S TWO
 *    ENUMERATIONS DISAGREE ABOUT `bsc`. Measured on the running service
 *    2026-10-10: `GET /api/nft/opensea?chains` (the venue's own `/chains`
 *    response) lists 29 chains and does NOT contain `bsc`, while
 *    `?chain=bsc&address=0x6816…1548` returns a real NFT and the wallets board
 *    renders "1 NFT on bsc" from it. The 36 slugs below are the enumeration
 *    OpenSea printed in the 400 above, so they carry `bsc` plus six siblings that
 *    `/chains` omits. A resolver reading the live list instead of this one would
 *    have called the treasury's MAIN wallet unsupported — which is why this is a
 *    measured, offline copy: `null` here means "this app will not guess", never
 *    "OpenSea cannot serve it". A caller holding a slug it verified itself can
 *    pass it straight to the route, which does not consult this list.
 * 3. WHAT THE APP ACTUALLY STORES IS MEASURED TWICE. `bsc` and `solana` are both
 *    in the enumeration AND were read live by address; they are the only two the
 *    treasury's three wallets can produce today.
 */
export const OPENSEA_CHAINS = [
  'abstract',
  'animechain',
  'ape_chain',
  'arbitrum',
  'arbitrum_nova',
  'arc',
  'avalanche',
  'b3',
  'base',
  'bera_chain',
  'bitcoin',
  'blast',
  'bsc',
  'ethereum',
  'flow',
  'gunzilla',
  'hyperevm',
  'hyperliquid',
  'immutable',
  'ink',
  'megaeth',
  'monad',
  'optimism',
  'polygon',
  'robinhood',
  'ronin',
  'sei',
  'shape',
  'solana',
  'somnia',
  'soneium',
  'stablechain',
  'tenderly_virtual_base',
  'tenderly_virtual_mainnet',
  'unichain',
  'zora',
] as const;

const KNOWN: ReadonlySet<string> = new Set<string>(OPENSEA_CHAINS);

/**
 * The slug for a stored chain name, or `null` when this app refuses to guess.
 * `null` is a fact to render ("no slug for this chain"), never a silent no-op:
 * a caller that treats it as "no NFTs" would be manufacturing the same
 * confident-empty-state the OpenSea client's `missing-key` guard exists to
 * prevent.
 */
export function chainSlug(display: string | null | undefined): string | null {
  if (!display) return null;
  const folded = display.trim().toLowerCase().replace(/\s+/g, '');
  if (!folded) return null;
  if (KNOWN.has(folded)) return folded;
  // 'BNB Chain', 'BNB', 'Ethereum Mainnet' — a name this app has not measured.
  // Guessing a slug for it is how a 400 becomes a UI bug; refuse instead.
  return null;
}
