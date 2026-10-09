import { NextResponse } from 'next/server';
import { query } from '@/server/db';
import { requireMutationAuth } from '@/server/auth';
import { failInternal } from '../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    // `wallets` is keyed on `address` (text) and has NO integer primary key, so
    // `ORDER BY rowid` cannot be translated: `toPostgres` rewrites it to `ORDER BY id`,
    // which does not exist here, and the resulting 500 was swallowed by the caller's
    // `.catch(() => [])` — the surface then rendered a calm "Wallets (0)". `created_at`
    // is the stored insertion time; `address` breaks the tie (the seeded rows share one
    // timestamp), so the order stays deterministic.
    const wallets = await query('SELECT * FROM wallets ORDER BY created_at, address');
    return NextResponse.json(wallets);
  } catch (e: unknown) {
    return failInternal(e);
  }
}

export async function POST(req: Request) {
  const denied = await requireMutationAuth(req);
  if (denied) return denied;
  try {
    const { address, alias, emoji, color, notes } = await req.json();
    if (!address) return NextResponse.json({ error: 'address required' }, { status: 400 });
    
    const sets: string[] = [];
    const params: any[] = [];
    if (alias !== undefined) { sets.push('alias = ?'); params.push(alias); }
    if (emoji !== undefined) { sets.push('emoji = ?'); params.push(emoji); }
    if (color !== undefined) { sets.push('color = ?'); params.push(color); }
    if (notes !== undefined) { sets.push('notes = ?'); params.push(notes); }
    
    if (sets.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
    
    params.push(address);
    await query(`UPDATE wallets SET ${sets.join(', ')} WHERE address = ?`, params);
    
    const updated = await query('SELECT * FROM wallets WHERE address = ?', [address]);
    if (updated.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json(updated[0]);
  } catch (e: unknown) {
    return failInternal(e);
  }
}