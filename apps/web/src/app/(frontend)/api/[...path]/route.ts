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
 * | coinmarketcap              | :3101 /api/cmc  | 75s     | X-CMC-Upstream, X-CMC-Cache, Cache-Control     |
 * | llama                      | :3101 /api/ll   | 60s     | X-Cache, Cache-Control (+15s default on 200)   |
 * | news                       | :3101 /api/news | 60s     | X-Cache, Cache-Control (+15s default on 200)   |
 * | reconcile                  | :3102           | 45s     | X-Reconcile-Upstream, Cache-Control: no-store  |
 * | executor (all methods)     | :3105           | 35s     | see @/server/executor-proxy                    |
 *
 * The failure policy is the house rule and is unchanged: fail loud with the
 * real reason. An unreachable sidecar answers 502 carrying
 * `{ error, upstream, kind? }` — never a fake 200, never a silent fallback.
 * `kind` is the request's own selector (`mode` for the data families,
 * `source` for news), exactly as the per-family handlers reported it.
 *
 * The Go sidecar still owns all validation; this file re-implements none of
 * it (no mode table, no signature, no decrypt). `scripts/verify/check-contract.py`
 * asserts that invariant against THIS source now that the per-family files are
 * gone, and `contracts/scripts/check-contract.mjs` resolves every documented
 * path through this gateway's routing table.
 */
export const dynamic = 'force-dynamic';

/** The `:3101` data families this gateway serves, in one place the gates parse. */
const DATA_FAMILY_NAMES = ['cryptorank', 'coinank', 'coinglass', 'coinmarketcap', 'llama', 'news'];

/** `:3101` data sidecar base URL (apps/data). Runtime read: a restart picks it up. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';
/** `:3102` Rust reconcile service base URL (apps/reconciler, DR-014). */
const RECONCILE = process.env.RECONCILE_URL ?? 'http://127.0.0.1:3102';

interface DataFamily {
  /** Loopback hop budget, per family (matches the deleted handler). */
  timeout: number;
  /** Upstream headers replayed verbatim. */
  relay: string[];
  /** Query param naming the family's selector, reported as `kind` on a 502. */
  kind: 'mode' | 'source';
  /** Cache-Control default set on a 200 when upstream set none (llama/news). */
  defaultCache?: string;
}

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
};

/** The real reason a loopback hop failed (Node's fetch hides it on `err.cause`). */
function realReason(err: unknown): string {
  return err instanceof Error
    ? [err.message, (err.cause as Error | undefined)?.message].filter((s): s is string => Boolean(s)).join(': ')
    : String(err);
}

/** Forward a `GET /api/<family>?…` to the `:3101` sidecar, verbatim. */
async function forwardDataFamily(req: NextRequest, family: string): Promise<Response> {
  const cfg = DATA_FAMILIES[family];
  const upstream = `${DATA_URL}/api/${family}`;
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
    return NextResponse.json(
      { error: `fudcourt-data unreachable: ${realReason(err)}`, upstream, kind: req.nextUrl.searchParams.get(cfg.kind) },
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
