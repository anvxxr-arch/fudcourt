import 'server-only';
import { limitedFetch } from '@/lib/rate-limit';
import {
  AGGREGATE_FIELDS, CONTEXT_FIELDS, MOVING_AVERAGES, OSCILLATORS, SCAN_TF,
  scanBody, scanColumns, shapeBoard, byId, type BoardPayload, type Instrument, type Timeframe,
} from './model';

/**
 * The upstream read. Server-only: the board's client component talks to
 * `/api/technicals`, which is the single door to the screener.
 *
 * WHY THIS IS NOT A GO SIDECAR FAMILY: the acquisition families under
 * `apps/data/` exist for upstreams with an anti-bot gate to undo (client
 * signatures, SSR scraping). This one answers a plain JSON POST with no
 * credential, so a Next route reads it in-process — the same shape
 * `features/market/sources/*` uses for FRED/BIS/World Bank.
 *
 * ONE REQUEST PER BOARD: the screener takes a ticker list crossed with a column
 * list, so every symbol x timeframe a page needs costs a single round trip
 * (measured 0.4s for 3 symbols x 8 timeframes). Looping per symbol would be a
 * self-inflicted burst against an upstream that has no published quota.
 */
export const SCAN_ENDPOINT = 'https://scanner.tradingview.com/global/scan';
export const SCAN_SOURCE = 'TradingView scanner (scanner.tradingview.com/global/scan)';
/**
 * The in-process memo window, in ms. The route answers with THIS constant
 * (`SCAN_TTL_MS / 1000`), so the edge window and the server window cannot drift
 * — the same pattern `MARKETS_TTL_MS` uses. Registered in
 * `tests/server-cache-tests.ts`, which asserts the pairing.
 */
export const SCAN_TTL_MS = 30_000;

export type TechnicalsErrorKind = 'no-symbols' | 'unknown-symbols' | 'upstream' | 'shape';

export class TechnicalsError extends Error {
  readonly kind: TechnicalsErrorKind;
  readonly status: number;
  constructor(kind: TechnicalsErrorKind, message: string, status: number) {
    super(message);
    this.name = 'TechnicalsError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The columns come back as a flat array positionally aligned with the request, so
 * the shape is reconstructed from the REQUESTED order rather than from any
 * `fields` echo — a mismatch there would silently shift every value one column
 * across, which renders as perfectly plausible prices.
 */
export function shapeScanResponse(
  payload: unknown,
  instruments: Instrument[],
  tfs: Timeframe[],
): { symbol: string; cells: Record<string, number | null> }[] {
  const columns = scanColumns(tfs);
  const rows = (payload as { data?: { s?: unknown; d?: unknown }[] } | null)?.data;
  if (!Array.isArray(rows)) throw new TechnicalsError('shape', 'scanner payload carried no data[]', 502);
  const out: { symbol: string; cells: Record<string, number | null> }[] = [];
  for (const row of rows) {
    if (typeof row?.s !== 'string' || !Array.isArray(row?.d)) continue;
    if (row.d.length !== columns.length) {
      throw new TechnicalsError(
        'shape',
        `scanner row ${row.s} carried ${row.d.length} cells for ${columns.length} columns`,
        502,
      );
    }
    const cells: Record<string, number | null> = {};
    columns.forEach((col, i) => {
      const v = row.d[i];
      cells[col] = typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
    out.push({ symbol: row.s, cells });
  }
  return out;
}

/** Resolve the URL's id list, refusing ids the registry does not carry. */
export function resolveInstruments(ids: string[]): Instrument[] {
  if (ids.length === 0) throw new TechnicalsError('no-symbols', 'no symbols requested', 400);
  const unknown = ids.filter((id) => !byId(id));
  if (unknown.length > 0) {
    throw new TechnicalsError('unknown-symbols', `unknown symbol(s): ${unknown.join(', ')}`, 404);
  }
  return ids.map((id) => byId(id)!);
}

/** Parse `?symbols=a,b,c`. */
export function parseIds(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Fetch and shape one board read. Throws TechnicalsError — never returns an empty board. */
export async function loadTechnicals(ids: string[], tfs: Timeframe[]): Promise<BoardPayload> {
  const instruments = resolveInstruments(ids);
  const body = scanBody(instruments, tfs);
  // The limiter caches and single-flights by URL, and a POST's body is not part
  // of the key, so the request is identified in the query string instead. The
  // screener answers a query string on the POST with the same 200 (measured).
  const url = `${SCAN_ENDPOINT}?symbols=${encodeURIComponent(instruments.map((i) => i.tv).join(','))}` +
    `&tf=${encodeURIComponent(tfs.join(','))}`;
  let res: Response;
  try {
    res = await limitedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Browser-shaped headers: the endpoint is the one the public widgets call.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        Origin: 'https://www.tradingview.com',
        Referer: 'https://www.tradingview.com/',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }, { ttlMs: SCAN_TTL_MS });
  } catch (err) {
    throw new TechnicalsError('upstream', `scanner unreachable: ${(err as Error).message}`, 502);
  }
  if (!res.ok) {
    throw new TechnicalsError('upstream', `scanner answered ${res.status}`, 502);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new TechnicalsError('shape', `scanner body was not JSON: ${(err as Error).message}`, 502);
  }
  const rows = shapeScanResponse(parsed, instruments, tfs);
  if (rows.length === 0) {
    throw new TechnicalsError('upstream', 'scanner returned no rows for the requested symbols', 502);
  }
  return shapeBoard(rows, instruments, tfs, {
    fetchedAt: new Date().toISOString(),
    source: SCAN_SOURCE,
  });
}

/** What the board and the route both quote: the fields that make up a read. */
export const READ_FIELDS = { OSCILLATORS, MOVING_AVERAGES, AGGREGATE_FIELDS, CONTEXT_FIELDS };
