import { NextRequest, NextResponse } from 'next/server';
import { forwardExecutor } from '@/server/executor-proxy';
/**
 * The collapsed pure-passthrough API surface (PLAN Phase 6C, ADR-006).
 *
 * WHY THIS FILE EXISTS. Twenty-two route handlers used to exist purely to
 * forward one request to one loopback sidecar and hand the response back:
 * six `:3101` data families (`cryptorank`, `coinank`, `coinglass`,
 * `coinmarketcap`, `llama`, `news`), the `:3102` reconcile proxy, and the
 * fifteen `:3105` executor shells. They are now one catch-all gateway.
 *
 * WHY A CATCH-ALL AT `/api/[...path]` AND NOT A REWRITE. Next resolves a
 * concrete route ahead of a catch-all, so every real application route
 * (`auth`, `economy`, `markets`, `market`, `ticker`, `transactions`,
 * `wallets`, `img`, `admin`, the Payload CMS tree) keeps its own handler and
 * is never reached through here — this file only ever sees a path that no
 * specific handler claimed. The request URL is therefore UNCHANGED, which is
 * what keeps the security boundary intact: `middleware.ts` gates on the
 * ORIGINAL pathname (`/api/reconcile` and `/api/executor/*` are team-tier,
 * see `@/server/auth`), and a rewrite to `/api/backend/*` would have left the
 * gateway reachable at a path the tier table does not gate — an auth hole.
 *
 * BEHAVIOR IS PRESERVED, PER FAMILY. Each family's envelope, timeout and
 * relayed headers are reproduced exactly as the deleted handler emitted them:
 *
 * | family                     | upstream        | timeout | relayed                                        |
 * |----------------------------|-----------------|---------|------------------------------------------------|
 * | cryptorank                 | :3101 /api/cr   | 60s     | X-CR-Upstream, X-CR-Cache, Cache-Control       |
 * | coinank                    | :3101 /api/cn   | 75s     | X-CA-Upstream, X-CA-Cache, Cache-Control       |
 * | coinglass                  | :3101 /api/cg   | 75s     | X-CG-Upstream, X-CG-Cache, X-CG-Cipher, CC     |
 * | coinmarketcap              | :3101 /api/coinmarketcap | 75s  | X-CMC-Upstream, X-CMC-Cache, Cache-Control     |
 * | llama                      | :3101 /api/ll   | 60s     | X-Cache, Cache-Control (+15s default on 200)   |
 * | news                       | :3101 /api/news | 60s     | X-Cache, Cache-Control (+15s default on 200)   |
 * | data (subpath allowlist)   | :3101 /api/data | 30s     | X-Cache, Cache-Control, Link, ETag (+15s dflt) |
 * | reconcile                  | :3102           | 45s     | X-Reconcile-Upstream, Cache-Control: no-store  |
 * | executor (all methods)     | :3105           | 35s     | see @/server/executor-proxy                    |
 *
 * The `data` family carries a path REMAINDER (`/api/data/metrics` → the
 * sidecar's own sub-route) and an explicit sub-path allowlist: `ingest`, `runs`
 * and `health` are operator-only and are refused here, never forwarded.
 *
 * The failure policy is the house rule and is unchanged: fail loud with the
 * real reason. An unreachable sidecar answers 502 carrying
 * `{ error, upstream, kind? }` — never a fake 200, never a silent fallback.
 * `kind` is the request's own selector (`mode` for the data families,
 * `source` for news), exactly as the per-family handlers reported it; it is
 * omitted for a family that has no selector (`data`).
 *
 * The Go sidecar still owns all validation; this file re-implements none of
 * it (no mode table, no signature, no decrypt). `scripts/verify/check-contract.py`
 * asserts that invariant against THIS source now that the per-family files are
 * gone, and `contracts/scripts/check-contract.mjs` resolves every documented
 * path through this gateway's routing table.
 */
export const dynamic = 'force-dynamic';

/** The `:3101` data families this gateway serves, in one place the gates parse. */
const DATA_FAMILY_NAMES = ['cryptorank', 'coinank', 'coinglass', 'coinmarketcap', 'llama', 'news', 'data'];

/** `:3101` data sidecar base URL (apps/data). Runtime read: a restart picks it up. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';
/** `:3102` Rust reconcile service base URL (apps/reconciler, DR-014). */
const RECONCILE = process.env.RECONCILE_URL ?? 'http://127.0.0.1:3102';

interface DataFamily {
  /** Loopback hop budget, per family (matches the deleted handler). */
  timeout: number;
  /** Upstream headers replayed verbatim. */
  relay: string[];
  /** Query param naming the family's selector, reported as `kind` on a 502.
   *  Absent for families with no selector (`data`). */
  kind?: 'mode' | 'source';
  /** Cache-Control default set on a 200 when upstream set none (llama/news). */
  defaultCache?: string;
  /** When set, only these FIRST path segments after the family name may be
   *  forwarded; anything else is a loud 404 here rather than a sidecar call. */
  subpaths?: readonly string[];
}

/**
 * The `/api/data/*` sub-paths the public gateway may forward. The data
 * platform's read surface is public market/research data (the same class the
 * market boards already serve), so it is safe to reach through the web tier.
 * Deliberately excluded:
 *   - `ingest` (POST /api/data/ingest/run) — a MUTATING trigger that fires a
 *     real upstream fetch and writes rows; the gateway is GET-only so a POST
 *     is already 405'd, but the segment is kept out of the allowlist too, so a
 *     future method change cannot expose it by accident.
 *   - `runs` — the ingestion run journal carries provider error TEXT, which is
 *     operator-facing, not public.
 *   - `health` — the readiness probe belongs on the operational surface, not
 *     the public one. The established pattern in this repo is loopback-only
 *     probes (apps/api's /healthz + /readyz are never proxied through the web
 *     tier); an operator reads the sidecar's `/api/data/health` directly on
 *     :3101.
 */
const DATA_SUBPATHS = [
  'assets',
  'instruments',
  'venues',
  'protocols',
  'chains',
  'series',
  'timeseries',
  'metrics',
  'charts',
  'ohlcv',
  'trades',
  'orderbook',
  'derivatives',
  'defi',
  'dex',
  'news',
  'prediction',
] as const;

/** Per-family forwarding shape. Keyed by the first path segment. */
const DATA_FAMILIES: Record<string, DataFamily> = {
  cryptorank: { timeout: 60_000, relay: ['X-CR-Upstream', 'X-CR-Cache', 'Cache-Control'], kind: 'mode' },
  coinank: { timeout: 75_000, relay: ['X-CA-Upstream', 'X-CA-Cache', 'Cache-Control'], kind: 'mode' },
  coinglass: {
    timeout: 75_000,
    relay: ['X-CG-Upstream', 'X-CG-Cache', 'X-CG-Cipher', 'Cache-Control'],
    kind: 'mode',
  },
  coinmarketcap: { timeout: 75_000, relay: ['X-CMC-Upstream', 'X-CMC-Cache', 'Cache-Control'], kind: 'mode' },
  llama: { timeout: 60_000, relay: ['X-Cache', 'Cache-Control'], kind: 'mode', defaultCache: 'public, max-age=15' },
  news: { timeout: 60_000, relay: ['X-Cache', 'Cache-Control'], kind: 'source', defaultCache: 'public, max-age=15' },
  // The durable read surface of the data platform (apps/data, /api/data/*).
  // Store reads are fast (no upstream fan-out), so the hop budget is small.
  // `Link` (the news keyset cursor) and `ETag` ride along exactly as the
  // dedicated /api/data/news route relays them.
  data: {
    timeout: 30_000,
    relay: ['X-Cache', 'Cache-Control', 'Link', 'ETag'],
    defaultCache: 'public, max-age=15',
    subpaths: DATA_SUBPATHS,
  },
};

/** The real reason a loopback hop failed (Node's fetch hides it on `err.cause`). */
function realReason(err: unknown): string {
  return err instanceof Error
    ? [err.message, (err.cause as Error | undefined)?.message].filter((s): s is string => Boolean(s)).join(': ')
    : String(err);
}

/** Forward a `GET /api/<family>[/<subpath>]?…` to the `:3101` sidecar, verbatim. */
async function forwardDataFamily(req: NextRequest, family: string): Promise<Response> {
  const cfg = DATA_FAMILIES[family];
  // The path REMAINDER after the family name travels with the request: the
  // sidecar's own sub-routes (/api/data/news, /api/data/metrics, …) are
  // addressed by it. Dropping it — as this forwarder did until 2026-10-12 —
  // silently re-pointed every sub-path at the family root, so
  // `/api/data/metrics?series_id=x` reached `:3101/api/data` and answered the
  // 404 envelope instead of the metric rows. The remainder is read from the
  // pathname (never from the query string) and is already percent-encoded by
  // the router, so it is forwarded verbatim.
  const remainder = req.nextUrl.pathname.slice(`/api/${family}`.length);
  // A family with an explicit allowlist refuses anything outside it HERE, on
  // the public edge, rather than letting an unlisted segment reach the sidecar.
  // The check is on the FIRST segment after the family name; a trailing path
  // (`/charts/index`) stays inside its allowed root.
  if (cfg.subpaths) {
    const first = remainder.replace(/^\//, '').split('/')[0];
    if (!cfg.subpaths.includes(first)) {
      return NextResponse.json(
        { error: 'not_found', detail: `no API route for /api/${family}${remainder}` },
        { status: 404 },
      );
    }
  }
  const upstream = `${DATA_URL}/api/${family}${remainder}`;
  // Exact same query string, untouched: the sidecar owns mode/key/fresh semantics.
  const target = `${upstream}${req.nextUrl.search}`;
  let res: Response;
  try {
    res = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(cfg.timeout),
    });
  } catch (err) {
    // `kind` is only meaningful for the selector-driven families; it is
    // omitted (not null) for a family that has no selector.
    return NextResponse.json(
      {
        error: `fudcourt-data unreachable: ${realReason(err)}`,
        upstream,
        ...(cfg.kind ? { kind: req.nextUrl.searchParams.get(cfg.kind) } : {}),
      },
      { status: 502 },
    );
  }
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of cfg.relay) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  if (cfg.defaultCache && res.status === 200 && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', cfg.defaultCache);
  }
  return new NextResponse(body, { status: res.status, headers });
}

/**
 * Forward `/api/v1/dex/*` to the `:3101` sidecar's canonical DEX surface (plan
 * §30). This is the FIRST provider-agnostic DEX path: the web tier asks for
 * canonical pools/candles/rankings and never names a provider. It is a thin
 * passthrough — the sidecar owns the contract, the gateway only relays it with
 * the same loud-502 posture as every other loopback hop.
 */
async function forwardV1(req: NextRequest): Promise<Response> {
  const upstream = `${DATA_URL}${req.nextUrl.pathname}${req.nextUrl.search}`;
  let res: Response;
  try {
    res = await fetch(upstream, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `fudcourt-data unreachable: ${realReason(err)}`, upstream },
      { status: 502 },
    );
  }
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ['X-Cache', 'Cache-Control', 'Link', 'ETag']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  if (res.status === 200 && !headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'public, max-age=15');
  }
  return new NextResponse(body, { status: res.status, headers });
}

/** Forward `GET /api/reconcile` to the `:3102` Rust service, verbatim. */
async function forwardReconcile(): Promise<Response> {
  const upstream = `${RECONCILE}/api/reconcile`;
  let res: Response;
  try {
    res = await fetch(upstream, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    return NextResponse.json({ error: `reconcile unreachable: ${realReason(err)}`, upstream }, { status: 502 });
  }
  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'X-Reconcile-Upstream': upstream, 'Cache-Control': 'no-store' },
  });
}

/** Route one request to the sidecar its first path segment names. */
async function dispatch(req: NextRequest, method: string): Promise<Response> {
  const family = req.nextUrl.pathname.replace(/^\/api\//, '').split('/')[0];
  // executor: every verb, forwarded to :3105 (the Go surface owns session/tier).
  if (family === 'executor') return forwardExecutor(req);
  // Everything else here is a GET-only read proxy: a non-GET is 405 (as Next
  // answered when the method was simply not exported by the deleted handler).
  if (method !== 'GET') return new NextResponse(null, { status: 405, headers: { Allow: 'GET' } });
  if (family === 'reconcile') return forwardReconcile();
  // The canonical DEX platform surface (plan §2/§30): /api/v1/dex/* is
  // provider-agnostic by construction, so it is relayed verbatim to the
  // sidecar's own /api/v1/dex/* routes.
  if (family === 'v1') return forwardV1(req);
  if (family in DATA_FAMILIES) return forwardDataFamily(req, family);
  // No specific handler claimed this path and no family serves it: not found.
  return NextResponse.json({ error: 'not_found', detail: `no API route for /${family}` }, { status: 404 });
}

export async function GET(req: NextRequest): Promise<Response> {
  return dispatch(req, 'GET');
}
export async function POST(req: NextRequest): Promise<Response> {
  return dispatch(req, 'POST');
}
export async function PUT(req: NextRequest): Promise<Response> {
  return dispatch(req, 'PUT');
}
export async function DELETE(req: NextRequest): Promise<Response> {
  return dispatch(req, 'DELETE');
}
export async function PATCH(req: NextRequest): Promise<Response> {
  return dispatch(req, 'PATCH');
}
