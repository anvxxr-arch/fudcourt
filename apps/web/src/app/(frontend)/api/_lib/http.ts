import { NextResponse } from 'next/server';

export function fail(message: string, status: number, detail?: string) {
  return NextResponse.json({ error: message, ...(detail ? { detail } : {}) }, { status });
}

/**
 * Log the real failure server-side and answer a generic 500. The raw
 * exception message can carry driver paths, SQL fragments and environment
 * detail, so clients only ever see this fixed envelope — nothing leaks.
 */
export function failInternal(e: unknown) {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  return NextResponse.json({ error: 'internal error' }, { status: 500 });
}

/**
 * A PUBLIC, read-only 200 with the one `Cache-Control` every such route shares.
 *
 * The value is the route's own in-process TTL, so the edge revalidates on the
 * same clock the server memo already runs on — never shorter (which would spend
 * an upstream call for nothing) and never longer (which would serve a figure the
 * board itself has already replaced). `s-maxage` is the shared cache; `max-age`
 * keeps a browser from re-asking on every navigation; `stale-while-revalidate`
 * lets a stale hit answer instantly while the refresh runs, which is the whole
 * point of putting a TTL on a board that must stay live.
 *
 * This is a separate helper from `fail`/`failInternal` (which answer errors and
 * deliberately carry no storeable header) so that every successful public read
 * gets the same value by construction rather than by a copy pasted per route.
 * Anything user-specific or auth-gated belongs on `noStoreJson`, never here.
 */
export function publicJson(body: unknown, ttlSeconds: number, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`);
  return NextResponse.json(body, { ...init, headers });
}
/**
 * A response that must never be stored by any cache: every auth-gated read and
 * every error. `no-store` is explicit rather than implied by the request having
 * a cookie, because the header is what the browser, the CDN and Lighthouse's
 * `bf-cache` audit all read.
 */
export function noStoreJson(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'private, no-store');
  return NextResponse.json(body, { ...init, headers });
} 
/**
 * The public origin this deployment answers on. `FUDCOURT_PUBLIC_ORIGIN`
 * may hold a comma-separated allowlist (e.g. "https://fudcourt.com,
 * https://www.fudcourt.com"); each entry is a full origin
 * ("<scheme>://<host>[:port]"). The first usable entry wins, otherwise the
 * caller falls back to the request's own URL host — never to a client-
 * controlled x-forwarded-host header.
 */
export function publicOrigin(url: URL): { scheme: string; host: string } {
  const raw = process.env.FUDCOURT_PUBLIC_ORIGIN ?? '';
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return { scheme: parsed.protocol.slice(0, -1), host: parsed.host };
      }
    } catch {
      continue;
    }
  }
  return { scheme: url.protocol.slice(0, -1), host: url.host };
}
