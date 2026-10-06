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

// Upstream chain support is NOT uniform:
//   /api/index   -> solana | robinhood only (chain=all returns 400)
//   /api/feed    -> solana | robinhood | all  (all = merged, counts split rh/sol)
//   /api/page    -> solana | robinhood | all
// So `all` is allowed per-mode rather than globally, or a valid `all` request
// gets a 400 from our own validator that the upstream would have served.
const CHAIN_BY_MODE: Record<string, Set<string>> = {
  index: new Set(['solana', 'robinhood']),
  feed: new Set(['solana', 'robinhood', 'all']),
  page: new Set(['solana', 'robinhood', 'all']),
  scoreboard: new Set(['solana', 'robinhood']),
};

const MODES = new Set(['index', 'feed', 'page', 'scoreboard']);

// Upstream /api/page validation, measured directly against the upstream:
//   n < 2      -> 400 {"error":"bad chain or page"}   (n=0, 1, and negatives)
//   n > pages  -> 404 {"error":"no such page"}       (n=11 when pages=10)
//   2..pages   -> 200
// An earlier version silently clamped out-of-range n into range. That is a lie
// about the request: a caller asking for page 0 got page 2's rows with a 200,
// and a caller asking for page 99 got page 10's rows with a 200 -- both
// indistinguishable from a real hit. Pass the value through untouched and let
// the upstream's own status code reach the client. The UI pager already bounds
// itself to 2..pages, so nothing internal depends on the clamp.
function validatePage(n: number) {
  if (!Number.isFinite(n) || n < 2) {
    return { error: 'bad chain or page', status: 400 };
  }
  if (n > 10) {
    // Upstream reports "no such page" with 404 for n beyond the last page.
    return { error: 'no such page', status: 404 };
  }
  return { ok: true as const };
}

// Fail-loud shape gate: runs BEFORE cache admission. A 200 whose body is not
// the payload family this mode serves must 502 loud, never be stored, and
// never be normalized into a plausible-looking "no signals" answer. The
// normalizer below defaults missing rows to [] and missing counts to {} --
// without this gate, `{}` from a broken upstream would cache for the full TTL
// as an authoritative empty board.
function isValidUpstream(mode: string, data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (mode === 'scoreboard') {
    // Scoreboard family: buckets + catches under `chains`, no `rows`.
    const chains = d.chains;
    return typeof chains === 'object' && chains !== null && Object.keys(chains).length > 0;
  }
  // Row family (index/feed/page): needs a rows array AND a counts object,
  // with at least one of them non-empty. Real payloads always carry counts
  // (at minimum counts.rows), so `{rows: [], counts: {}}` is an empty
  // envelope, not a quiet day -- reject it rather than cache the lie.
  if (!Array.isArray(d.rows)) return false;
  if (typeof d.counts !== 'object' || d.counts === null) return false;
  return d.rows.length > 0 || Object.keys(d.counts).length > 0;
}

// Route-local validated-payload cache with single-flight. Only bodies that
// pass isValidUpstream are admitted; malformed-200s and empty envelopes stay
// loud (502, uncached) on every request. Keyed by full target URL
// (mode + chain + n). Route-local (not the shared limiter) so a bad signals
// payload can never poison another family's cache entry, and so this gate
// stays reviewable next to the normalizer it protects.
const VALID_TTL_MS = 30_000;
const VALID_MAX_ENTRIES = 100;
type ValidEntry = { at: number; body: unknown };
const validated = new Map<string, ValidEntry>();
const validInflight = new Map<string, Promise<{ status: number; body: unknown }>>();

function takeValid(key: string): ValidEntry | undefined {
  const hit = validated.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= VALID_TTL_MS) {
    validated.delete(key);
    return undefined;
  }
  validated.delete(key);
  validated.set(key, hit);
  return hit;
}

function storeValid(key: string, entry: ValidEntry) {
  validated.delete(key);
  validated.set(key, entry);
  while (validated.size > VALID_MAX_ENTRIES) {
    const oldest = validated.keys().next();
    if (oldest.done) break;
    validated.delete(oldest.value);
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chain = (url.searchParams.get('chain') || 'solana').toLowerCase();
  const mode = (url.searchParams.get('type') || 'index').toLowerCase();

  // Validate `mode` first: the chain allowlist is looked up by mode, so an
  // unknown mode must not silently fall back to the index rules.
  if (!MODES.has(mode)) {
    return NextResponse.json({ error: `type must be one of ${Array.from(MODES).join(', ')}` }, { status: 400 });
  }
  const allowed = CHAIN_BY_MODE[mode];
  if (!allowed.has(chain)) {
    return NextResponse.json(
      { error: `chain must be one of ${Array.from(allowed).join(', ')} for type=${mode}` },
      { status: 400 }
    );
  }

  const target = new URL(`/api/${mode}`, UPSTREAM);
  target.searchParams.set('chain', chain);
  if (mode === 'page') {
    const raw = parseInt(url.searchParams.get('n') || '2', 10);
    const n = Number.isFinite(raw) ? raw : 2;
    // Mirror upstream validation instead of silently clamping: a caller who
    // asks for an out-of-range page must see an error, never someone else's rows.
    const verdict = validatePage(n);
    if (!('ok' in verdict)) {
      return NextResponse.json(
        { error: verdict.error, detail: `page ${n} is outside the upstream range 2..10` },
        { status: verdict.status }
      );
    }
    target.searchParams.set('n', String(n));
  }

  const key = target.toString();
  const cached = takeValid(key);
  if (cached) {
    return NextResponse.json(cached.body, { headers: { 'X-Cache': 'HIT' } });
  }
  const pending = validInflight.get(key);
  if (pending) {
    const shared = await pending;
    return NextResponse.json(shared.body, {
      status: shared.status,
      headers: { 'X-Cache': 'COALESCED' },
    });
  }

  const run = (async (): Promise<{ status: number; body: unknown }> => {
    let res: Response;
    try {
      res = await fetch(target, {
        cache: 'no-store',
        headers: { 'User-Agent': 'fudcourt-web/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 502, body: { error: `upstream unreachable: ${msg}` } };
    }

    if (!res.ok) {
      // Loud failure: a dead upstream must not surface as "0 signals found".
      const body = await res.text().catch(() => '');
      return {
        status: 502,
        body: { error: `upstream ${target.pathname} HTTP ${res.status}`, detail: body.slice(0, 200) },
      };
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      // A 200 that is not JSON is malformed, not empty: 502 loud, uncached.
      return { status: 502, body: { error: `upstream ${target.pathname} malformed: non-JSON 200 body` } };
    }

    // Discriminator BEFORE cache admission: wrong-family or empty payloads
    // never enter the cache and never reach the normalizer.
    if (!isValidUpstream(mode, data)) {
      return {
        status: 502,
        body: { error: `upstream ${target.pathname} malformed: 200 body failed ${mode} shape check` },
      };
    }

    // The scoreboard is a different payload family (buckets + catches, no
    // `rows`), so it gets its own branch. Feeding it through the row
    // normalizer would return rows: [] and counts: {} -- a plausible-looking
    // but entirely fabricated "no signals" answer.
    if (mode === 'scoreboard') {
      const sb = data as ScoreboardPayload;
      return {
        status: 200,
        body: {
          ...sb,
          kind: 'scoreboard',
          ...(sb.generatedAt !== undefined ? { generatedAt: sb.generatedAt } : {}),
          ...(sb.cohortDays !== undefined ? { cohortDays: sb.cohortDays } : {}),
          chains: sb.chains && typeof sb.chains === 'object' ? sb.chains : {},
          upstream: target.toString(),
        },
      };
    }

    const sig = data as SignalPayload;
    return {
      status: 200,
      body: {
        ...sig,
        chain: sig.chain ?? chain,
        generatedAt: sig.generatedAt ?? Math.floor(Date.now() / 1000),
        counts: sig.counts ?? {},
        rows: Array.isArray(sig.rows) ? sig.rows : [],
        upstream: target.toString(),
      },
    };
  })();

  validInflight.set(key, run);
  try {
    const winner = await run;
    // Only validated 200s are admitted. 502s (dead upstream, malformed-200,
    // empty envelope) are shared with coalesced waiters but never stored, so
    // the next request retries upstream instead of replaying the failure.
    if (winner.status === 200) {
      storeValid(key, { at: Date.now(), body: winner.body });
    }
    return NextResponse.json(winner.body, { status: winner.status, headers: { 'X-Cache': 'MISS' } });
  } finally {
    validInflight.delete(key);
  }
}
