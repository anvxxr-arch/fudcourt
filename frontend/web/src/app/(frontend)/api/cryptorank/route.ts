import { NextRequest, NextResponse } from 'next/server';
/**
 * CryptoRank read proxy. Mode-only input (never a raw path).
 *
 * Runtime path: this route is a THIN, HONEST PROXY to the Go service
 * `fudcourt-data` (backend/data, 127.0.0.1:3101). The Go service does the real
 * work: mode validation, key/list validation, disabled-mode refusal, the
 * browser-fingerprint fetch (tls-client chrome_131 + HTTP/2 — the only
 * combination measured to beat cryptorank.io's Cloudflare ClientHello
 * fingerprinting; see docs/architecture/TECH-STACK.md), the disk cache and the 429
 * backoff. Everything upstream returns is forwarded VERBATIM — status, body
 * and the X-CR-Upstream / X-CR-Cache / Cache-Control headers — so the public
 * surface (GET /api/cryptorank?mode=…[&key=…][&fresh=1] on :3100) keeps the
 * exact wire contract the pre-migration Python path had for every consumer
 * (src/components/CryptorankPage.tsx, scripts/verify/verify-cryptorank.py).
 * Measured caveat, so "verbatim" is not read as "byte-identical": the Go
 * service is field-for-field-compatible, not byte-for-byte. Its bodies are
 * framed by `Encoder.Encode` and therefore end in ONE trailing newline, and
 * JSON key order is its struct order rather than the TS insertion order
 * (verified on `mode=home`: identical key set, identical key order, values
 * deep-equal, and byte-identical only after trimming that newline). Consumers
 * parse JSON, so this is invisible to them — but anything hashing a body
 * verbatim must know it.
 *
 * Single source of truth: the mode/key validation and the disabled-mode
 * refusal (`funding`, `unlocks` — upstream's /_next/data class serves
 * synthetic decoy: nonexistent slugs -> 200 fabricated payloads, prices off
 * ground truth by 30%, measured 2026-09-27) live in Go ONLY. Re-validating
 * here would be a second implementation waiting to drift; frontend/web/scripts/
 * check-contract.py asserts the two mode tables can never diverge.
 *
 * scripts/oracle/cr_fetch.py is NO LONGER a runtime path. It is retained solely as
 * the independent oracle of scripts/verify/verify-cryptorank.py, which cross-checks
 * the Go service's output against a second, unrelated client.
 *
 * Failure policy (house rule): fail loud. If the sidecar is unreachable or
 * times out -> 502 carrying the real reason. Never a fake 200, never an
 * empty envelope, never a substituted payload.
 */
export const dynamic = 'force-dynamic';

/** Go sidecar base URL. Runtime read: a restart picks up changes without a rebuild. */
const DATA_URL = process.env.FUDCOURT_DATA_URL ?? 'http://127.0.0.1:3101';

/** Largest payload is mode=chain at ~1.19 MB — give the sidecar room. */
const TIMEOUT_MS = 60_000;

/* -------------------------------- handler ------------------------------- */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode');
  const upstream = `${DATA_URL}/api/cryptorank`;
  // Exact same query string, untouched: the sidecar owns mode/key/fresh
  // semantics (validation, defaults, refusal). We never rewrite params.
  const target = `${upstream}${req.nextUrl.search}`;

  let res: Response;
  try {
    res = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable, refused, DNS failure or our 60s timeout — real reason only.
    // Node's fetch reports a generic "fetch failed"; the actionable cause
    // (ECONNREFUSED, ENOTFOUND, our AbortSignal timeout, …) is on err.cause.
    const reason =
      err instanceof Error
        ? [err.message, (err.cause as Error | undefined)?.message]
            .filter((s): s is string => Boolean(s))
            .join(': ')
        : String(err);
    return NextResponse.json(
      { error: `fudcourt-data unreachable: ${reason}`, upstream, kind: mode },
      { status: 502 },
    );
  }

  // Verbatim pass-through: parse nothing, interpret nothing.
  const body = await res.text();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const h of ['X-CR-Upstream', 'X-CR-Cache', 'Cache-Control']) {
    const v = res.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return new NextResponse(body, { status: res.status, headers });
}
