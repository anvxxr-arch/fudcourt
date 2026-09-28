import { NextResponse } from 'next/server';
import { query } from '../../../../lib/db';
import { requireMutationAuth } from '../../../../lib/mutation-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const denied = requireMutationAuth(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const id = parseInt(params.id);
    if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

    const sets: string[] = [];
    const params_arr: any[] = [];

    if (body.date !== undefined) { sets.push('date = ?'); params_arr.push(body.date); }
    if (body.chain !== undefined) { sets.push('chain = ?'); params_arr.push(body.chain); }
    if (body.asset !== undefined) { sets.push('asset = ?'); params_arr.push(body.asset); }
    if (body.event !== undefined) { sets.push('event = ?'); params_arr.push(body.event); }
    if (body.amount_usd !== undefined) { sets.push('amount_usd = ?'); params_arr.push(parseFloat(body.amount_usd)); }
    if (body.direction !== undefined) { sets.push('direction = ?'); params_arr.push(body.direction); }
    if (body.memo !== undefined) { sets.push('memo = ?'); params_arr.push(body.memo); }
    if (body.wallet_to !== undefined) { sets.push('wallet_to = ?'); params_arr.push(body.wallet_to); }
    if (body.venue_id !== undefined) { sets.push('venue_id = ?'); params_arr.push(body.venue_id); }
    if (body.trade_id !== undefined) { sets.push('trade_id = ?'); params_arr.push(body.trade_id); }
    if (body.hash !== undefined) { sets.push('hash = ?'); params_arr.push(body.hash); }
    if (body.url !== undefined) { sets.push('url = ?'); params_arr.push(body.url); }
    if (body.source !== undefined) { sets.push('source = ?'); params_arr.push(body.source); }

    if (sets.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

    params_arr.push(id);
    await query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, params_arr);

    const rows = await query('SELECT * FROM transactions WHERE id = ?', [id]);
    return NextResponse.json(rows[0] || {});
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const denied = requireMutationAuth(req);
  if (denied) return denied;
  try {
    const body = await req.json();
    const id = parseInt(params.id);
    if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

    const sets: string[] = [];
    const params_arr: any[] = [];

    if (body.date !== undefined) { sets.push('date = ?'); params_arr.push(body.date); }
    if (body.chain !== undefined) { sets.push('chain = ?'); params_arr.push(body.chain); }
    if (body.asset !== undefined) { sets.push('asset = ?'); params_arr.push(body.asset); }
    if (body.event !== undefined) { sets.push('event = ?'); params_arr.push(body.event); }
    if (body.amount_usd !== undefined) { sets.push('amount_usd = ?'); params_arr.push(parseFloat(body.amount_usd)); }
    if (body.direction !== undefined) { sets.push('direction = ?'); params_arr.push(body.direction); }
    if (body.memo !== undefined) { sets.push('memo = ?'); params_arr.push(body.memo); }
    if (body.wallet_to !== undefined) { sets.push('wallet_to = ?'); params_arr.push(body.wallet_to); }
    if (body.venue_id !== undefined) { sets.push('venue_id = ?'); params_arr.push(body.venue_id); }
    if (body.trade_id !== undefined) { sets.push('trade_id = ?'); params_arr.push(body.trade_id); }
    if (body.hash !== undefined) { sets.push('hash = ?'); params_arr.push(body.hash); }
    if (body.url !== undefined) { sets.push('url = ?'); params_arr.push(body.url); }
    if (body.source !== undefined) { sets.push('source = ?'); params_arr.push(body.source); }

    if (sets.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

    params_arr.push(id);
    await query(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`, params_arr);

    const rows = await query('SELECT * FROM transactions WHERE id = ?', [id]);
    return NextResponse.json(rows[0] || {});
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const denied = requireMutationAuth(req);
  if (denied) return denied;
  try {
    const id = parseInt(params.id);
    if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

    const before = await query('SELECT * FROM transactions WHERE id = ?', [id]);
    if (before.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });

    await query('DELETE FROM transactions WHERE id = ?', [id]);
    return NextResponse.json({ deleted: true, id, row: before[0] });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
