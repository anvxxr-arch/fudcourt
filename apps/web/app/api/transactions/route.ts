import { NextResponse } from 'next/server';
import { query } from '../../../lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100');
    const offset = parseInt(searchParams.get('offset') || '0');
    const search = searchParams.get('search') || '';
    const chain = searchParams.get('chain') || '';
    const venue = searchParams.get('venue') || '';
    const direction = searchParams.get('direction') || '';
    const fromDate = searchParams.get('from') || '';
    const toDate = searchParams.get('to') || '';

    let sql = 'SELECT * FROM transactions WHERE 1=1';
    const params: any[] = [];

    if (search) {
      sql += ' AND (memo LIKE ? OR event LIKE ? OR hash LIKE ? OR wallet_to LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (chain) { sql += ' AND chain = ?'; params.push(chain); }
    if (venue) { sql += ' AND venue_id = ?'; params.push(venue); }
    if (direction) { sql += ' AND direction = ?'; params.push(direction); }
    if (fromDate) { sql += ' AND date >= ?'; params.push(fromDate); }
    if (toDate) { sql += ' AND date <= ?'; params.push(toDate); }

    sql += ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = await query(sql, params);

    // Total count with same filters
    let countSql = 'SELECT COUNT(*) as c FROM transactions WHERE 1=1';
    const countParams: any[] = [];
    if (search) {
      countSql += ' AND (memo LIKE ? OR event LIKE ? OR hash LIKE ? OR wallet_to LIKE ?)';
      const s = `%${search}%`;
      countParams.push(s, s, s, s);
    }
    if (chain) { countSql += ' AND chain = ?'; countParams.push(chain); }
    if (venue) { countSql += ' AND venue_id = ?'; countParams.push(venue); }
    if (direction) { countSql += ' AND direction = ?'; countParams.push(direction); }
    if (fromDate) { countSql += ' AND date >= ?'; countParams.push(fromDate); }
    if (toDate) { countSql += ' AND date <= ?'; countParams.push(toDate); }

    const countRes = await query(countSql, countParams);

    return NextResponse.json({
      transactions: rows,
      total: (countRes[0] as any).c,
      limit, offset, search, chain, venue, direction, fromDate, toDate
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Bulk insert
    if (body.bulk && Array.isArray(body.transactions)) {
      const results = [];
      for (const tx of body.transactions) {
        const amt = parseFloat(tx.amount_usd) || 0;
        const dir = tx.direction || (amt >= 0 ? 'IN' : 'OUT');
        await query(
          `INSERT INTO transactions (date, chain, asset, event, amount_usd, direction, memo, wallet_to, venue_id, trade_id, hash, url, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tx.date || new Date().toISOString().slice(0, 10),
            tx.chain || 'Offchain',
            tx.asset || 'USDT',
            tx.event,
            amt,
            dir,
            tx.memo || null,
            tx.wallet_to || null,
            tx.venue_id || null,
            tx.trade_id || null,
            tx.hash || null,
            tx.url || null,
            tx.source || 'manual'
          ]
        );
        const r = await query('SELECT * FROM transactions ORDER BY id DESC LIMIT 1');
        results.push(r[0]);
      }
      return NextResponse.json({ inserted: results.length, transactions: results });
    }

    // Single insert
    const {
      date, chain, asset, event, amount_usd, direction,
      memo, wallet_to, venue_id, trade_id, hash, url, source
    } = body;

    if (!date || !event) {
      return NextResponse.json({ error: 'date and event required' }, { status: 400 });
    }

    const amt = parseFloat(amount_usd) || 0;
    const dir = direction || (amt >= 0 ? 'IN' : 'OUT');

    await query(
      `INSERT INTO transactions (date, chain, asset, event, amount_usd, direction, memo, wallet_to, venue_id, trade_id, hash, url, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        date || new Date().toISOString().slice(0, 10),
        chain || 'Offchain',
        asset || 'USDT',
        event,
        amt,
        dir,
        memo || null,
        wallet_to || null,
        venue_id || null,
        trade_id || null,
        hash || null,
        url || null,
        source || 'manual'
      ]
    );

    const rows = await query('SELECT * FROM transactions ORDER BY id DESC LIMIT 1');
    return NextResponse.json(rows[0]);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// Bulk operations
export async function DELETE(req: Request) {
  try {
    const body = await req.json();
    const ids = body.ids;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array required' }, { status: 400 });
    }

    const placeholders = ids.map(() => '?').join(',');
    await query(`DELETE FROM transactions WHERE id IN (${placeholders})`, ids);

    return NextResponse.json({ deleted: true, count: ids.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const ids = body.ids;
    const updates = body.updates || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array required' }, { status: 400 });
    }

    const sets: string[] = [];
    const params: any[] = [];

    if (updates.date !== undefined) { sets.push('date = ?'); params.push(updates.date); }
    if (updates.chain !== undefined) { sets.push('chain = ?'); params.push(updates.chain); }
    if (updates.asset !== undefined) { sets.push('asset = ?'); params.push(updates.asset); }
    if (updates.event !== undefined) { sets.push('event = ?'); params.push(updates.event); }
    if (updates.amount_usd !== undefined) { sets.push('amount_usd = ?'); params.push(parseFloat(updates.amount_usd)); }
    if (updates.direction !== undefined) { sets.push('direction = ?'); params.push(updates.direction); }
    if (updates.memo !== undefined) { sets.push('memo = ?'); params.push(updates.memo); }
    if (updates.wallet_to !== undefined) { sets.push('wallet_to = ?'); params.push(updates.wallet_to); }
    if (updates.venue_id !== undefined) { sets.push('venue_id = ?'); params.push(updates.venue_id); }
    if (updates.trade_id !== undefined) { sets.push('trade_id = ?'); params.push(updates.trade_id); }
    if (updates.hash !== undefined) { sets.push('hash = ?'); params.push(updates.hash); }
    if (updates.url !== undefined) { sets.push('url = ?'); params.push(updates.url); }
    if (updates.source !== undefined) { sets.push('source = ?'); params.push(updates.source); }

    if (sets.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 });

    const placeholders = ids.map(() => '?').join(',');
    params.push(...ids);
    await query(`UPDATE transactions SET ${sets.join(', ')} WHERE id IN (${placeholders})`, params);

    return NextResponse.json({ updated: true, count: ids.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
