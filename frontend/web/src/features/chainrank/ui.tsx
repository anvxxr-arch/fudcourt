'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { alpha, color, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { Loading } from '@/components/ui/feedback';
import { Banner } from '@/components/ui/banner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { ChainrankPage, ChainrankStats, ChainrankRow } from './client';

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
 * lives in scripts/verify/verify-chainrank.py.
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
      <div style={{ display: 'flex', alignItems: 'center', gap: space[10], flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ color: color.text, fontSize: fontSize[16], fontWeight: fontWeight.heavy }}>ChainRank — paid leaderboard</h3>
        <button onClick={load}
          style={{ background: color.surface, color: color.text, border: `1px solid ${color.border}`, padding: '5px 12px', borderRadius: radius[6], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
        {fetchedAt != null && !stale && (
          <span style={{ color: color.textMuted, fontSize: fontSize[10] }}>
            {new Date(fetchedAt * 1000).toLocaleTimeString()}
          </span>
        )}
      </div>
      <p style={{ color: color.textMuted, fontSize: fontSize[10], margin: `0 0 ${space[10]}px` }}>
        read-only relay of chainrank.fyi · reverse-engineered public endpoints (stats + listings) · an em-dash means
        the field is absent upstream, never zero · writes (click/presence/claim) are deliberately not proxied
      </p>

      {error && (
        <Banner variant="error" style={{ fontWeight: fontWeight.bold, marginBottom: space[8] }}>
          ⚠ chainrank error: {error} — no data faked{stale && stats ? ' · showing last good board below, stamped' : ''}
        </Banner>
      )}

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: space[8], marginBottom: space[12] }}>
          {[
            { k: 'online now', v: stats.online },
            { k: 'listings', v: stats.listings },
            { k: 'total clicks', v: stats.totalClicks },
            { k: 'on the board', v: usd(stats.totalUsdCents) },
            { k: 'top listing', v: usd(stats.topUsdCents) },
            { k: 'claim #1 costs', v: usd(stats.claimTopCents) },
          ].map((s) => (
            <div key={s.k} style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius[8], padding: `${space[8]}px ${space[10]}px` }}>
              <div style={{ color: color.textMuted, fontSize: fontSize[9], textTransform: 'uppercase', letterSpacing: letterSpacing.xs }}>{s.k}</div>
              <div style={{ color: color.text, fontSize: fontSize[16], fontWeight: fontWeight.heavy, marginTop: 2 }}>{s.v}</div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <Loading label="loading chainrank board…" />
      ) : error && !board ? (
        <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>row list withheld — the request above failed.</p>
      ) : (
        <>
          {stale && (
            <p style={{ color: color.warn, fontSize: fontSize[10], margin: `0 0 ${space[8]}px`, fontWeight: fontWeight.bold }}>
              ⚠ last good board from {fetchedAt ? new Date(fetchedAt * 1000).toLocaleTimeString() : 'unknown time'} — refresh failed
            </p>
          )}
          <Table style={{ fontSize: fontSize[12] }}>
            <THead>
              <TR style={{ borderBottom: 0 }}>
                <TH style={{ padding: `5px ${space[8]}px`, width: 44, fontWeight: fontWeight.bold }}>rank</TH>
                <TH style={{ padding: `5px ${space[8]}px`, fontWeight: fontWeight.bold }}>product</TH>
                <TH align="right" style={{ padding: `5px ${space[8]}px`, fontWeight: fontWeight.bold }}>raised</TH>
                <TH align="right" style={{ padding: `5px ${space[8]}px`, fontWeight: fontWeight.bold }}>clicks</TH>
                <TH style={{ padding: `5px ${space[8]}px`, fontWeight: fontWeight.bold }}>last paid</TH>
                <TH style={{ padding: `5px ${space[8]}px`, fontWeight: fontWeight.bold }}>listed</TH>
              </TR>
            </THead>
            <TBody>
              {rows.length === 0 && (
                <TR style={{ borderBottom: 0 }}><TD colSpan={6} style={{ color: color.textMuted, padding: space[12] }}>upstream returned no listings — genuinely empty, nothing faked.</TD></TR>
              )}
              {rows.map((r) => (
                <TR key={r.id} style={{ borderTop: `1px solid ${color.border}`, borderBottom: 0 }}>
                  <TD style={{ padding: `7px ${space[8]}px`, color: r.rank <= 3 ? color.accent : color.text, fontWeight: fontWeight.bold }}>{r.rank}</TD>
                  <TD style={{ padding: `7px ${space[8]}px` }}>
                    <a href={r.url} target="_blank" rel="noopener nofollow"
                      style={{ color: color.text, textDecoration: 'none', fontWeight: fontWeight.bold }}>{r.title || r.handle || r.key}</a>
                    <div style={{ color: color.textMuted, fontSize: fontSize[9] }}>{r.handle ? `@${r.handle}` : r.url}</div>
                  </TD>
                  <TD align="right" style={{ padding: `7px ${space[8]}px`, color: color.text, fontWeight: fontWeight.bold }}>{usd(r.totalUsdCents)}</TD>
                  <TD align="right" style={{ padding: `7px ${space[8]}px`, color: color.text }}>{r.clicks ?? '—'}</TD>
                  <TD style={{ padding: `7px ${space[8]}px`, color: color.textMuted }}>{age(r.lastPaidAt)}</TD>
                  <TD style={{ padding: `7px ${space[8]}px`, color: color.textMuted }}>{age(r.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div style={{ display: 'flex', gap: space[8], alignItems: 'center', marginTop: space[10] }}>
            <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={{ background: color.surface, color: page <= 1 ? color.textMuted : color.text, border: `1px solid ${color.border}`, padding: `${space[4]}px ${space[10]}px`, borderRadius: radius[6], fontSize: fontSize[11], cursor: page <= 1 ? 'default' : 'pointer', opacity: page <= 1 ? 0.5 : 1 }}>
              ‹ prev
            </button>
            <span style={{ color: color.textMuted, fontSize: fontSize[11] }}>page {page} / {totalPages} · {total} listing{total === 1 ? '' : 's'}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
              style={{ background: color.surface, color: page >= totalPages ? color.textMuted : color.text, border: `1px solid ${color.border}`, padding: `${space[4]}px ${space[10]}px`, borderRadius: radius[6], fontSize: fontSize[11], cursor: page >= totalPages ? 'default' : 'pointer', opacity: page >= totalPages ? 0.5 : 1 }}>
              next ›
            </button>
          </div>
        </>
      )}
    </div>
  );
}
