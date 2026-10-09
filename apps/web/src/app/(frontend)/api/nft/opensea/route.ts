import {
  OPENSEA_TTL_MS,
  OpenSeaError,
  accountNfts,
  contractNfts,
  getCollection,
  listCollections,
} from '@/features/nft/opensea';
import { fail, failInternal, publicJson } from '../../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/**
 * Public read over OpenSea v2. No tier: this is public chain data, not the
 * private holdings the `/api/treasury` family gates.
 *
 *   ?collection=<slug>                 one collection record        (keyless)
 *   ?collections=<n>                   the venue's collection index (keyless)
 *   ?chain=<slug>&contract=<address>   the NFTs of one contract     (needs key)
 *   ?chain=<slug>&address=<wallet>     the NFTs one account holds   (needs key)
 */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const chain = p.get('chain');
  const contract = p.get('contract');
  const address = p.get('address');
  const slug = p.get('collection');
  const limit = p.get('limit') ?? (p.has('collections') ? p.get('collections') : 20);

  let doRead: () => Promise<unknown>;
  if (slug) {
    doRead = () => getCollection(slug);
  } else if (chain && contract) {
    doRead = () => contractNfts(chain, contract, limit);
  } else if (chain && address) {
    doRead = () => accountNfts(chain, address, limit);
  } else if (p.has('collections')) {
    doRead = () => listCollections(limit);
  } else {
    return fail(
      'specify ?collections=<n>, ?collection=<slug>, ?chain=<slug>&contract=<address>, or ?chain=<slug>&address=<wallet>',
      400,
    );
  }

  try {
    return publicJson(await doRead(), Math.round(OPENSEA_TTL_MS / 1000));
  } catch (e) {
    // The three failure kinds get three statuses, so a caller never has to parse
    // prose to tell "this deployment has no key" (503) from "OpenSea never
    // answered" (504) from "OpenSea answered badly, key included" (502).
    if (e instanceof OpenSeaError) {
      const status = e.kind === 'missing-key' ? 503 : e.kind === 'transport' ? 504 : 502;
      return fail(e.message, status);
    }
    return failInternal(e);
  }
}
