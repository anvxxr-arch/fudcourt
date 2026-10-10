'use client';

import { useEffect, useState } from 'react';
import { themeColor, fontSize, radius, space } from '@/styles/tokens';
import { chainSlug } from '@/lib/opensea-chains';

type Nft = {
  identifier: string;
  collection: string;
  name: string | null;
  image_url: string | null;
  opensea_url?: string;
};

/**
 * Four states, and the empty one is only reachable when a read SUCCEEDED.
 * `unresolved` (no slug for the stored chain) and `error` (the venue answered
 * badly) must never render as "no NFTs" — that is the failure shape this repo
 * already paid for when `/api/wallets` 500'd behind a `.catch(() => [])` and the
 * surface printed a calm `Wallets (0)` (DR-055).
 */
type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; nfts: Nft[] }
  | { kind: 'failed'; reason: string };

const THUMB = 48;

export default function WalletNfts({ chain, address, limit = 6 }: { chain: string; address: string; limit?: number }) {
  const slug = chainSlug(chain);
  const [state, setState] = useState<State>({ kind: 'idle' });

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setState({ kind: 'loading' });
    const url = `/api/nft/opensea?chain=${encodeURIComponent(slug)}&address=${encodeURIComponent(address)}&limit=${limit}`;
    fetch(url)
      .then(async (res) => {
        // A non-2xx carries a reason the route named (`503 OPENSEA_API_KEY is not
        // configured`, `502 OpenSea responded …`); surface it instead of a
        // swallowed empty list.
        const body = await res.json().catch(() => null);
        if (!alive) return;
        if (!res.ok) {
          setState({ kind: 'failed', reason: (body as { error?: string } | null)?.error || `HTTP ${res.status}` });
          return;
        }
        setState({ kind: 'ok', nfts: Array.isArray((body as { nfts?: Nft[] } | null)?.nfts) ? ((body as { nfts: Nft[] }).nfts) : [] });
      })
      .catch((e: unknown) => {
        if (alive) setState({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [slug, address, limit]);

  const label = { fontSize: fontSize[11], color: themeColor.labelTertiary } as const;

  // No slug: say so, name the chain, and send no request. Silence here would read
  // as "this wallet holds nothing".
  if (!slug) {
    return (
      <div style={{ ...label, marginTop: space[8] }} title={`no OpenSea chain slug resolves for "${chain}" — the mapping is a measured list, not a guess`}>
        <span style={{ color: themeColor.red }}>⚠ NFT</span> no slug for {chain}
      </div>
    );
  }

  if (state.kind === 'loading' || state.kind === 'idle') {
    return <div style={{ ...label, marginTop: space[8] }}>checking {slug}…</div>;
  }

  if (state.kind === 'failed') {
    return (
      <div style={{ ...label, marginTop: space[8], wordBreak: 'break-word' }} title={state.reason}>
        <span style={{ color: themeColor.red }}>⚠ NFT</span> {state.reason.length > 90 ? `${state.reason.slice(0, 90)}…` : state.reason}
      </div>
    );
  }

  if (state.nfts.length === 0) {
    return (
      <div style={{ ...label, marginTop: space[8] }}>
        no NFTs on {slug}
      </div>
    );
  }

  return (
    <div style={{ marginTop: space[8] }}>
      <div style={{ ...label, marginBottom: space[4] }}>
        {state.nfts.length}
        {state.nfts.length >= limit ? '+' : ''} NFT{state.nfts.length === 1 ? '' : 's'} on {slug}
      </div>
      {/* flexWrap + a fixed thumb is the whole responsive story: the row reflows
          at any width without a media query, and each thumb is 48px so it clears
          the 24x24 touch floor with room to spare. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space[4], alignItems: 'center' }}>
        {state.nfts.map((n) => {
          const title = n.name && n.name.trim() ? n.name : `${n.collection} #${n.identifier}`;
          const thumb = n.image_url ? (
            <img
              src={n.image_url}
              alt={title}
              loading="lazy"
              width={THUMB}
              height={THUMB}
              style={{ width: THUMB, height: THUMB, objectFit: 'cover', borderRadius: radius[8], border: `1px solid ${themeColor.separator}`, display: 'block' }}
            />
          ) : (
            <span title={`${title} — no image_url in the response`} style={{ width: THUMB, height: THUMB, borderRadius: radius[8], border: `1px dashed ${themeColor.separator}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: fontSize[10], color: themeColor.labelTertiary }}>n/a</span>
          );
          return n.opensea_url ? (
            <a key={`${n.collection}-${n.identifier}`} href={n.opensea_url} target="_blank" rel="noreferrer" title={title} style={{ display: 'block', lineHeight: 0 }}>
              {thumb}
            </a>
          ) : (
            <span key={`${n.collection}-${n.identifier}`} title={title} style={{ display: 'block', lineHeight: 0 }}>
              {thumb}
            </span>
          );
        })}
      </div>
    </div>
  );
}
