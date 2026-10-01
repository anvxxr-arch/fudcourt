import { NextResponse } from 'next/server';
import { store } from '@/platform/executor/store';
import { deleteAccount, notFound, requireExecutorUser } from '@/platform/executor/runtime';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Params = { params: Promise<{ id: string }> };

/** GET /api/executor/accounts/:id — one account, masked key only (PRD §87, §109). */
export async function GET(_req: Request, { params }: Params) {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const account = await store.getCredential(auth.user.id, id);
  if (!account) return notFound('account');
  return NextResponse.json({ account });
}

/** DELETE /api/executor/accounts/:id — revocation, never a plaintext round trip (PRD §87). */
export async function DELETE(_req: Request, { params }: Params) {
  const auth = await requireExecutorUser();
  if (auth.denied) return auth.denied;
  const { id } = await params;
  const result = await deleteAccount(store, auth.user, id);
  return 'status' in result ? result : NextResponse.json(result);
}
