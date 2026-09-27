import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import path from 'node:path';
import {
  CR_BASE,
  CR_DISABLED,
  CR_DISABLED_REASON,
  CR_MODES,
  CR_MODE_ARGS,
  CR_MODE_UPSTREAM,
  type CrCoin,
  type CrEnvelope,
  type CrGlobal,
  type CrLiveMode,
  type CrMode,
  type CrFundingRound,
  type CrTrendingRow,
  type CrUpcomingIco,
} from '../../../lib/cryptorank';

/**
 * CryptoRank read proxy. Mode-only input (never a raw path); the fetch itself
 * happens in scripts/cr_fetch.py under a dedicated curl_cffi venv, because
 * cryptorank.io's API host challenges every non-browser TLS client while its
 * market pages serve their SSR payload through curl_cffi (see lib header).
 *
 * Failure policy (house rule): upstream wall -> 502 with the real upstream
 * status and the helper's own error string. Nothing is ever substituted.
 *
 * Data-integrity policy: modes listed in CR_DISABLED are REFUSED with 503 +
 * the measured reason -- upstream's /_next/data class serves synthetic decoy
 * (nonexistent slugs -> 200 fabricated payloads, prices off ground truth by
 * 30%, measured 2026-09-27). We never forward a payload we cannot trust.
 */

export const dynamic = 'force-dynamic';

const PYTHON = process.env.CR_PYTHON ?? '/home/dwizzy/.venvs/crfetch/bin/python';
const HELPER = path.join(process.cwd(), 'scripts', 'cr_fetch.py');

type HelperOut = {
  ok: boolean;
  path?: string;
  status?: number;
  error?: string;
  pageProps?: Record<string, unknown>;
  fetchedAt?: number;
  cache?: string;
};

function runHelper(mode: CrMode, fresh = false): Promise<HelperOut> {
  return new Promise((resolve) => {
    const [flag, value] = CR_MODE_ARGS[mode];
    const args = fresh ? [HELPER, flag, value, '--ttl', '0'] : [HELPER, flag, value];
    execFile(
      PYTHON,
      args,
      { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse(stdout) as HelperOut;
          resolve(parsed);
        } catch {
          resolve({
            ok: false,
            error: `helper produced no JSON: ${err ? String(err.message) : ''} ${String(stderr).slice(-300)}`.trim(),
          });
        }
      },
    );
  });
}

/* ------------------------------- shaping ------------------------------- */

const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Upstream ships some numerics as strings (token-unlock marketCap). */
const asNumLoose = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
/** Upstream marks undisclosed names/types as '~'; render as absent (em-dash), not as a tilde. */
const asStrOrDash = (v: unknown): string | null => {
  const s = asStr(v);
  return s === '~' ? null : s;
};
const asPriceUsd = (v: unknown): number | null =>
  v && typeof v === 'object' ? asNum((v as Record<string, unknown>).USD) : asNum(v);

type RawCoin = Record<string, unknown>;

function shapeCoin(r: RawCoin, change24h: number | null): CrCoin {
  const category = r.category as { name?: unknown } | null;
  const ath = r.athPrice as Record<string, unknown> | null;
  const athDate = r.athMarketCap as Record<string, unknown> | null;
  return {
    rank: asNum(r.rank),
    key: asStr(r.key) ?? '',
    name: asStr(r.name) ?? asStr(r.fullName) ?? '',
    symbol: asStr(r.symbol) ?? '',
    image: asStr(r.image),
    priceUsd: asPriceUsd(r.price),
    marketCap: asNum(r.marketCap),
    volume24hUsd: asNum(r.volume24hUsd) ?? asNum(r.volume24h),
    category: category && typeof category.name === 'string' ? category.name : null,
    listingDate: asStr(r.listingDate),
    lifeCycle: asStr(r.lifeCycle),
    athUsd: ath ? asPriceUsd(ath) : null,
    change24h,
  };
}

/**
 * 24h change from upstream's own histPrices anchor: histPrices['24H'].USD is
 * the price 24h ago. Plain arithmetic on upstream fields -- labelled in the
 * envelope as derived, never presented as a native field.
 */
function changeFromAnchor(r: RawCoin): number | null {
  const hist = r.histPrices as Record<string, Record<string, unknown>> | null;
  const anchor = hist?.['24H']?.USD;
  const now = (r.price as Record<string, unknown> | null)?.USD;
  const a = asNum(anchor);
  const n = asNum(now);
  if (a == null || n == null || a === 0) return null;
  return ((n - a) / a) * 100;
}

function shapeGlobal(pp: Record<string, unknown>): CrGlobal {
  const init = (pp.initData ?? {}) as Record<string, unknown>;
  const g = (init.globalData ?? {}) as Record<string, unknown>;
  const gas = (g.gas ?? {}) as Record<string, unknown>;
  const avg = (gas.average ?? {}) as Record<string, unknown>;
  return {
    totalMarketCap: asNum(g.totalMarketCap),
    totalMarketCapChangePercent: asNum(g.totalMarketCapChangePercent),
    totalVolume24h: asNum(g.totalVolume24h),
    totalVolume24hChangePercent: asNum(g.totalVolume24hChangePercent),
    btcDominance: asNum(g.btcDominance),
    btcDominanceChangePercent: asNum(g.btcDominanceChangePercent),
    ethDominance: asNum(g.ethDominance),
    ethDominanceChangePercent: asNum(g.ethDominanceChangePercent),
    allCurrencies: asNum(g.allCurrencies),
    gasGwei: asNum(avg.gasPriceGwei),
  };
}

function shapeFunding(r: Record<string, unknown>): CrFundingRound {
  const coin = (r.coin ?? {}) as Record<string, unknown>;
  const funds = Array.isArray(r.funds) ? (r.funds as Record<string, unknown>[]) : [];
  return {
    date: asStrOrDash(r.date),
    type: asStrOrDash(r.type),
    raiseUsd: asNum(r.raise),
    valuationUsd: asNum(r.valuation),
    coinName: asStrOrDash(coin.name),
    coinKey: asStr(coin.key),
    coinIcon: asStr(coin.icon),
    funds: funds.map((f) => asStrOrDash(f.name)).filter((n): n is string => n != null),
  };
}

function shapeIco(r: Record<string, unknown>): CrUpcomingIco {
  const coin = (r.coin ?? {}) as Record<string, unknown>;
  const platform = (r.platform ?? {}) as Record<string, unknown>;
  return {
    name: asStrOrDash(coin.name),
    symbol: asStrOrDash(coin.symbol),
    key: asStr(coin.key),
    platform: asStrOrDash(platform.name),
    raiseUsd: asNum(r.raise),
    date: asStr(r.date),
  };
}

function shapeTrending(r: RawCoin): CrTrendingRow {
  return {
    rank: asNum(r.rank),
    key: asStr(r.key) ?? '',
    name: asStr(r.name) ?? '',
    symbol: asStr(r.symbol) ?? '',
    image: asStr(r.image),
    priceUsd: asPriceUsd(r.price),
    change24h: asNum(r.priceChange24h),
    marketCap: asNum(r.marketCap),
    volume24hUsd: asNum(r.volume24hUsd) ?? asNum(r.volume24h),
    high24h: asNum(r.highPrice24h),
    low24h: asNum(r.lowPrice24h),
  };
}

function envelope(kind: CrLiveMode, h: HelperOut): CrEnvelope {
  const pp = (h.pageProps ?? {}) as Record<string, unknown>;
  const base = {
    kind,
    upstream: CR_MODE_UPSTREAM[kind],
    fetchedAt: h.fetchedAt ?? Math.floor(Date.now() / 1000),
    cache: h.cache ?? 'MISS',
  };

  if (kind === 'home') {
    const fundingRaw = Array.isArray(pp.fallbackRecentFundingRounds)
      ? (pp.fallbackRecentFundingRounds as Record<string, unknown>[])
      : [];
    const icoRaw = Array.isArray(pp.upcomingIco) ? (pp.upcomingIco as Record<string, unknown>[]) : [];
    return {
      ...base,
      count: fundingRaw.length + icoRaw.length,
      slice:
        `homepage slice: ${fundingRaw.length} most recent rounds + ${icoRaw.length} upcoming IDOs; ` +
        'the full fundraising boards (/funding-rounds, /ico*) are WAF-challenged to every non-browser client',
      global: shapeGlobal(pp),
      fundingRounds: fundingRaw.map(shapeFunding),
      upcomingIco: icoRaw.map(shapeIco),
    };
  }

  if (kind === 'coins') {
    const coins = Array.isArray(pp.coins) ? (pp.coins as RawCoin[]) : [];
    return {
      ...base,
      count: coins.length,
      upstreamTotal: coins.length,
      changeSource: 'unavailable',
      rows: coins.map((r) => shapeCoin(r, null)),
    };
  }

  if (kind === 'trending') {
    const table = (pp.fallbackTableData ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(table.data) ? (table.data as RawCoin[]) : [];
    return {
      ...base,
      count: rows.length,
      upstreamTotal: asNum(table.total) ?? rows.length,
      changeSource: 'direct',
      rows: rows.map(shapeTrending),
    };
  }

  // gainers / losers -- same upstream row shape, change derived from anchor
  const rows = Array.isArray(pp.fallbackData) ? (pp.fallbackData as RawCoin[]) : [];
  return {
    ...base,
    count: rows.length,
    upstreamTotal: rows.length,
    changeSource: 'derived-from-histPrices-24H',
    rows: rows.map((r) => shapeCoin(r, changeFromAnchor(r))),
  };
}

/* -------------------------------- handler ------------------------------- */

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') as CrMode | null;
  if (!mode || !CR_MODES.includes(mode)) {
    return NextResponse.json(
      { error: 'unknown mode', modes: CR_MODES, got: mode },
      { status: 400 },
    );
  }

  const fresh = req.nextUrl.searchParams.get('fresh') === '1';

  // Data-integrity refusal: these modes' upstream class serves synthetic
  // decoy (see CR_DISABLED_REASON). Loud 503, never a forwarded payload.
  if (mode === 'funding' || mode === 'unlocks') {
    return NextResponse.json(
      {
        error: CR_DISABLED_REASON,
        kind: mode,
        disabled: true,
        upstream: CR_MODE_UPSTREAM[mode],
        reverify: 'scripts/verify-cryptorank.py (nonexistent-slug must 404 + independent ground-truth match)',
      },
      { status: 503 },
    );
  }

  const h = await runHelper(mode, fresh);
  if (!h.ok) {
    // Real failure, real detail: upstream wall status or helper crash text.
    return NextResponse.json(
      {
        error: h.error ?? 'cryptorank helper failed',
        upstreamStatus: h.status ?? null,
        upstream: CR_MODE_UPSTREAM[mode],
        kind: mode,
      },
      { status: 502 },
    );
  }

  const body = envelope(mode, h);
  return NextResponse.json(body, {
    headers: {
      'X-CR-Upstream': body.upstream,
      'X-CR-Cache': body.cache,
      'Cache-Control': 'public, max-age=30',
    },
  });
}
