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
