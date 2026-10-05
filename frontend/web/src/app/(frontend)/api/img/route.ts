import { NextRequest, NextResponse } from 'next/server';

/**
 * Internal image proxy: GET /api/img?u=<encoded https url>.
 *
 * All browser image traffic stays internal: renderers route data-driven
 * <img> / background-image URLs through here instead of hot-linking
 * upstream hosts. SSRF-safe: exact-host allowlist only (enumerated from live
 * API payloads), HTTPS only, no redirects to unapproved hosts, 8s timeout,
 * 5MB cap, image content-types only.
 */
export const dynamic = 'force-dynamic';

const ALLOWED_HOSTS: Record<string, true> = {
  's3-images.ctmedia.io': true,
  'cdn.dexscreener.com': true,
  'icons.llamao.fi': true,
  'coin-images.coingecko.com': true,
  'images.cryptorank.io': true,
};

const ALLOWED_CT: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/gif': true,
  'image/avif': true,
  'image/svg+xml': true,
};

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 5 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('u');
  if (!raw) return NextResponse.json({ error: 'missing u' }, { status: 400 });
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: 'bad url' }, { status: 400 });
  }
  if (target.protocol !== 'https:') {
    return NextResponse.json({ error: 'https only' }, { status: 400 });
  }
  if (!ALLOWED_HOSTS[target.hostname]) {
    return NextResponse.json({ error: 'host not allowed' }, { status: 403 });
  }
  let res: Response;
  try {
    res = await fetch(target.toString(), {
      method: 'GET',
      headers: { accept: 'image/*' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `upstream fetch failed: ${reason}` }, { status: 502 });
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (!loc) return NextResponse.json({ error: 'redirect without location' }, { status: 502 });
    let next: URL;
    try {
      next = new URL(loc, target);
    } catch {
      return NextResponse.json({ error: 'bad redirect' }, { status: 502 });
    }
    if (next.protocol !== 'https:' || !ALLOWED_HOSTS[next.hostname]) {
      return NextResponse.json({ error: 'redirect to non-allowlisted host' }, { status: 403 });
    }
    try {
      res = await fetch(next.toString(), {
        method: 'GET',
        headers: { accept: 'image/*' },
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `upstream fetch failed: ${reason}` }, { status: 502 });
    }
    if (res.status >= 300 && res.status < 400) {
      return NextResponse.json({ error: 'too many redirects' }, { status: 502 });
    }
  }
  if (!res.ok) {
    return NextResponse.json({ error: `upstream ${res.status}` }, { status: 502 });
  }
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CT[ct]) {
    return NextResponse.json({ error: 'not an image' }, { status: 415 });
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'image too large' }, { status: 413 });
  }
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'content-type': ct,
      'cache-control': 'public, max-age=86400, immutable',
      'content-length': String(buf.byteLength),
    },
  });
}
