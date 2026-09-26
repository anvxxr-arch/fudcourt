import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const UPSTREAM = 'https://data-public.vercel.app';

// Sighting counts / holder counts are sparse across the upstream rows, so
// every field is optional. A missing metric must never render as 0.
export type SignalRow = {
  id: number;
  ts: number;
  kind: string;
  chain: string;
  mint: string;
  symbol: string;
  name: string;
  url: string;
  mcap: number;
  liq?: number;
  price?: number;
  ageMin?: number;
  score?: number;
  decision?: string;
  source?: string;
  image?: string;
  holdersCount?: number;
  vetoes?: string[];
  volTrend?: number;
  topHolderPct?: number;
  nameReuse?: number;
  persistCount?: number;
  registryReuse?: number;
  sightings?: { n: number; spanH: number; sources: number; surfaced: number };
  socials?: { type: string; url: string }[];
};

export type ScoreboardBucket = {
  day: string;
  n: number;
  run: number;
  flat: number;
  dump: number;
  unknown: number;
};

export type ScoreboardCatch = {
  mint: string;
  symbol: string;
  score: number;
  decision: string;
  peak24: number;
  chain: string;
  day: string;
  x24h?: number;
};

export type ScoreboardChain = {
  latest: ScoreboardBucket;
  cohortDays: number;
  series: ScoreboardBucket[];
  catches: ScoreboardCatch[];
};

export type ScoreboardPayload = {
  v: number;
  kind: 'scoreboard';
  generatedAt: number;
  cohortDays: number;
  chains: Record<string, ScoreboardChain>;
};

export type SignalCounts = {
  rows?: number;
  rh?: number;
  sol?: number;
  surfaced?: number;
  runs?: number;
  revivals?: number;
};

export type SignalPayload = {
  v?: number;
  kind?: string;
  chain: string;
  page?: number;
  pages?: number;
  pageRows?: number;
  total?: number;
  generatedAt: number;
  windowH?: number;
  solDelayMin?: number;
  counts: SignalCounts;
  rows: SignalRow[];
};

const CHAINS = new Set(['solana', 'robinhood']);
const MODES = new Set(['index', 'feed', 'page', 'scoreboard']);

// Upstream /api/page rejects n<2 and n>pages with 4xx -- clamp instead of
// letting the browser burn requests on guaranteed failures.
function clampPage(n: number, pages: number) {
  return Math.min(Math.max(n, 2), Math.max(pages, 2));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chain = (url.searchParams.get('chain') || 'solana').toLowerCase();
  const mode = (url.searchParams.get('type') || 'index').toLowerCase();

  if (!CHAINS.has(chain)) {
    return NextResponse.json({ error: 'chain must be robinhood or solana' }, { status: 400 });
  }
  if (!MODES.has(mode)) {
    return NextResponse.json({ error: `type must be one of ${Array.from(MODES).join(', ')}` }, { status: 400 });
  }

  const target = new URL(`/api/${mode}`, UPSTREAM);
  target.searchParams.set('chain', chain);
  if (mode === 'page') {
    const raw = parseInt(url.searchParams.get('n') || '2', 10);
    const n = Number.isFinite(raw) ? raw : 2;
    target.searchParams.set('n', String(clampPage(n, 10)));
  }

  try {
    const res = await fetch(target, {
      cache: 'no-store',
      headers: { 'User-Agent': 'fudcourt-web/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      // Loud failure: a dead upstream must not surface as "0 signals found".
      const body = await res.text().catch(() => '');
      return NextResponse.json(
        { error: `upstream ${target.pathname} HTTP ${res.status}`, detail: body.slice(0, 200) },
        { status: 502 }
      );
    }

    const data = (await res.json()) as SignalPayload | ScoreboardPayload;

    // The scoreboard is a different payload family (buckets + catches, no
    // `rows`), so it gets its own branch. Feeding it through the row
    // normalizer would return rows: [] and counts: {} -- a plausible-looking
    // but entirely fabricated "no signals" answer.
    if (mode === 'scoreboard') {
      const sb = data as ScoreboardPayload;
      return NextResponse.json({
        ...sb,
        kind: 'scoreboard',
        generatedAt: sb.generatedAt ?? Math.floor(Date.now() / 1000),
        cohortDays: sb.cohortDays ?? 0,
        chains: sb.chains && typeof sb.chains === 'object' ? sb.chains : {},
        upstream: target.toString(),
      });
    }

    const sig = data as SignalPayload;
    return NextResponse.json({
      ...sig,
      chain: sig.chain ?? chain,
      generatedAt: sig.generatedAt ?? Math.floor(Date.now() / 1000),
      counts: sig.counts ?? {},
      rows: Array.isArray(sig.rows) ? sig.rows : [],
      upstream: target.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `upstream unreachable: ${msg}` }, { status: 502 });
  }
}
