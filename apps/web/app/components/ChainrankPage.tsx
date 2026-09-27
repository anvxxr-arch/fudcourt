'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { C } from '../../lib/ui/shared';
import type { ChainrankPage, ChainrankStats, ChainrankRow } from '../../lib/chainrank';

/** cents -> $x.xx. Absent/null is an em-dash, never 0 (house rule). */
function usd(c: number | null | undefined) {
  if (c == null) return '—';
  return `$${(c / 100).toFixed(2)}`;
}

function age(iso: string | null | undefined) {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

const PAGE_SIZE = 20;

/**
 * ChainRank board (chainrank.fyi) through the /api/chainrank read proxy.
 *
 * Reads only -- click/presence/claim/upload are real writes against someone
 * else's production service and stay out of this UI by design. The contract
 * lives in scripts/verify-chainrank.py.
 */
export default function ChainrankPage() {
  const [stats, setStats] = useState<ChainrankStats | null>(null);
  const [board, setBoard] = useState<ChainrankPage | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  // Tracks whether a board ever loaded WITHOUT depending on `board` itself:
  // listing `board` in load's deps and then setBoard-ing inside load would
  // re-run the effect forever (new object identity each time).
  const hasBoard = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [sRes, bRes] = await Promise.all([
        fetch('/api/chainrank?mode=stats', { cache: 'no-store' }),
        fetch(`/api/chainrank?mode=listings&page=${page}&pageSize=${PAGE_SIZE}`, { cache: 'no-store' }),
      ]);
      const sJson = await sRes.json().catch(() => ({}));
      const bJson = await bRes.json().catch(() => ({}));
      if (!sRes.ok) throw new Error(sJson.error || `stats HTTP ${sRes.status}`);
      if (!bRes.ok) throw new Error(bJson.error || `listings HTTP ${bRes.status}`);
      setStats(sJson);
      setBoard(bJson);
      setFetchedAt(bJson.fetchedAt ?? Math.floor(Date.now() / 1000));
      setStale(false);
      hasBoard.current = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      // Withhold rows on a cold failure; on a warm failure keep the last good
      // board but flag it stale (same split as Signals).
      setStale(hasBoard.current);
      if (!hasBoard.current) setBoard(null);
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const rows: ChainrankRow[] = board?.rows ?? [];
  const total = board?.total ?? 0;
  const totalPages = board?.totalPages ?? 1;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h3 style={{ color: C.white, fontSize: 15, fontWeight: 800 }}>ChainRank — paid leaderboard</h3>
        <button onClick={load}
          style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '5px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
        {fetchedAt != null && !stale && (
          <span style={{ color: C.dim, fontSize: 10 }}>
            {new Date(fetchedAt * 1000).toLocaleTimeString()}
          </span>
        )}
      </div>
      <p style={{ color: C.dim, fontSize: 10, margin: '0 0 10px' }}>
        read-only relay of chainrank.fyi · reverse-engineered public endpoints (stats + listings) · an em-dash means
        the field is absent upstream, never zero · writes (click/presence/claim) are deliberately not proxied
      </p>

      {error && (
        <p style={{ color: C.red, fontSize: 12, fontWeight: 700, background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.35)', padding: '8px 10px', borderRadius: 6, marginBottom: 8 }}>
          ⚠ chainrank error: {error} — no data faked{stale && stats ? ' · showing last good board below, stamped' : ''}
        </p>
      )}

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 12 }}>
          {[
            { k: 'online now', v: stats.online },
            { k: 'listings', v: stats.listings },
            { k: 'total clicks', v: stats.totalClicks },
            { k: 'on the board', v: usd(stats.totalUsdCents) },
            { k: 'top listing', v: usd(stats.topUsdCents) },
            { k: 'claim #1 costs', v: usd(stats.claimTopCents) },
          ].map((s) => (
            <div key={s.k} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ color: C.dim, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4 }}>{s.k}</div>
              <div style={{ color: C.white, fontSize: 15, fontWeight: 800, marginTop: 2 }}>{s.v}</div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>loading chainrank board…</p>
      ) : error && !board ? (
        <p style={{ color: C.dim, fontSize: 12 }}>row list withheld — the request above failed.</p>
      ) : (
        <>
          {stale && (
            <p style={{ color: '#fbbf24', fontSize: 10, margin: '0 0 8px', fontWeight: 700 }}>
              ⚠ last good board from {fetchedAt ? new Date(fetchedAt * 1000).toLocaleTimeString() : 'unknown time'} — refresh failed
            </p>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: C.dim, textAlign: 'left' }}>
                <th style={{ padding: '5px 8px', width: 44 }}>rank</th>
                <th style={{ padding: '5px 8px' }}>product</th>
                <th style={{ padding: '5px 8px', textAlign: 'right' }}>raised</th>
                <th style={{ padding: '5px 8px', textAlign: 'right' }}>clicks</th>
                <th style={{ padding: '5px 8px' }}>last paid</th>
                <th style={{ padding: '5px 8px' }}>listed</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} style={{ color: C.dim, padding: 12 }}>upstream returned no listings — genuinely empty, nothing faked.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: '7px 8px', color: r.rank <= 3 ? C.accent : C.white, fontWeight: 700 }}>{r.rank}</td>
                  <td style={{ padding: '7px 8px' }}>
                    <a href={r.url} target="_blank" rel="noopener nofollow"
                      style={{ color: C.white, textDecoration: 'none', fontWeight: 700 }}>{r.title || r.handle || r.key}</a>
                    <div style={{ color: C.dim, fontSize: 9 }}>{r.handle ? `@${r.handle}` : r.url}</div>
                  </td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', color: C.white, fontWeight: 700 }}>{usd(r.totalUsdCents)}</td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', color: C.white }}>{r.clicks ?? '—'}</td>
                  <td style={{ padding: '7px 8px', color: C.dim }}>{age(r.lastPaidAt)}</td>
                  <td style={{ padding: '7px 8px', color: C.dim }}>{age(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
            <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={{ background: C.card, color: page <= 1 ? C.dim : C.white, border: `1px solid ${C.border}`, padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: page <= 1 ? 'default' : 'pointer', opacity: page <= 1 ? 0.5 : 1 }}>
              ‹ prev
            </button>
            <span style={{ color: C.dim, fontSize: 11 }}>page {page} / {totalPages} · {total} listing{total === 1 ? '' : 's'}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
              style={{ background: C.card, color: page >= totalPages ? C.dim : C.white, border: `1px solid ${C.border}`, padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: page >= totalPages ? 'default' : 'pointer', opacity: page >= totalPages ? 0.5 : 1 }}>
              next ›
            </button>
          </div>
        </>
      )}
    </div>
  );
}
