import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';

// Mutation auth (NFR-4, R-6): write methods are fail-closed.
// - Server validates header `x-fud-token` against env FUD_MUTATION_TOKEN.
// - Env absent (e.g. the public Vercel deployment) => every mutation 401.
// - Local UI sends NEXT_PUBLIC_FUD_MUTATION_TOKEN (inlined at build time).
// GET/read paths are untouched — reads stay open on the LAN deployment.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function requireMutationAuth(req: Request): NextResponse | null {
  const secret = process.env.FUD_MUTATION_TOKEN;
  const got = req.headers.get('x-fud-token') ?? '';
  if (!secret || !got || !safeEqual(got, secret)) {
    return NextResponse.json(
      { error: 'unauthorized', detail: 'mutation requires a valid x-fud-token' },
      { status: 401 },
    );
  }
  return null;
}
