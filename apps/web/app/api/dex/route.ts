import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const DEX = 'https://api.dexscreener.com';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get('type') || 'profiles';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

    let data;

    if (type === 'profiles') {
      // New token profiles
      const res = await fetch(`${DEX}/token-profiles/latest/v1`);
      if (!res.ok) throw new Error(`DexScreener ${res.status}`);
      const raw = await res.json();
      data = (raw || []).slice(0, limit).map((t: any) => ({
        address: t.tokenAddress,
        chain: t.chainId,
        icon: t.icon,
        header: t.header,
        description: t.description,
        links: t.links,
        url: t.url,
      }));
    } else if (type === 'pairs') {
      // New pairs
      const chain = url.searchParams.get('chain') || 'solana';
      const res = await fetch(`${DEX}/latest/dex/pairs/${chain}`);
      if (!res.ok) throw new Error(`DexScreener ${res.status}`);
      const raw = await res.json();
      data = (raw.pairs || []).slice(0, limit).map((p: any) => ({
        pairAddress: p.pairAddress,
        baseToken: p.baseToken?.symbol,
        quoteToken: p.quoteToken?.symbol,
        priceUsd: p.priceUsd,
        priceChange24h: p.priceChange?.h24,
        volume24h: p.volume?.h24,
        liquidity: p.liquidity?.usd,
        fdv: p.fdv,
        chainId: p.chainId,
        dexId: p.dexId,
        url: p.url,
        createdAt: p.pairCreatedAt,
      }));
    } else if (type === 'search') {
      // Search tokens
      const q = url.searchParams.get('q') || 'BTC';
      const res = await fetch(`${DEX}/latest/dex/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`DexScreener ${res.status}`);
      const raw = await res.json();
      data = (raw.pairs || []).slice(0, limit).map((p: any) => ({
        pairAddress: p.pairAddress,
        baseToken: p.baseToken?.symbol,
        quoteToken: p.quoteToken?.symbol,
        priceUsd: p.priceUsd,
        priceChange24h: p.priceChange?.h24,
        volume24h: p.volume?.h24,
        liquidity: p.liquidity?.usd,
        chainId: p.chainId,
        dexId: p.dexId,
        url: p.url,
      }));
    } else {
      throw new Error('Unknown type');
    }

    return NextResponse.json({ data, timestamp: Date.now() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, data: [] }, { status: 500 });
  }
}
