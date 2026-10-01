import { NextResponse } from 'next/server';
import { store } from '@/platform/executor/store';
import { connectAccount, listAccounts, requireExecutorUser } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/executor/accounts — the session user's connected exchange accounts (PRD §97). */
export async function GET() {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  return NextResponse.json(await listAccounts(store, auth.user));
}

/** POST /api/executor/accounts — BYOK connect (PRD §43-46). Secrets are sealed server-side and never returned. */
export async function POST(req: Request) {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const result = await connectAccount(store, auth.user, {
    exchange: body.exchange,
    label: body.label,
    apiKey: body.apiKey,
    apiSecret: body.apiSecret,
    passphrase: body.passphrase,
  });
  return 'status' in result ? result : NextResponse.json(result);
}
