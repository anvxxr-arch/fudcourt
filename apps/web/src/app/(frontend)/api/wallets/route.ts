import { NextResponse } from 'next/server';
import { query } from '@/server/db';
import { requireMutationAuth } from '@/server/auth';
import { failInternal } from '../_lib/http';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const wallets = await query('SELECT * FROM wallets ORDER BY rowid');
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