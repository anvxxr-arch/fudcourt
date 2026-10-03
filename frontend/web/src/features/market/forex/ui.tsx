'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/components/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Toolbar } from '@/components/ui/toolbar';
import { fmtRate, fmtTime } from '@/features/market/format';
import type { ForexPair } from '@/features/market/forex/client';

type Envelope = {
  pairs?: ForexPair[];
  base?: string;
  updated?: number | null;
  derived?: string;
  error?: string;
  detail?: string;
};

/** Forex board: curated major pairs from /api/market/forex. */
export default function ForexBoard() {
  const [pairs, setPairs] = useState<ForexPair[]>([]);
  const [base, setBase] = useState('USD');
  const [updated, setUpdated] = useState<number | null>(null);
  const [derived, setDerived] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/market/forex', { cache: 'no-store' });
      const body: Envelope = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ? `${body.error}${body.detail ? ` — ${body.detail}` : ''}` : `HTTP ${res.status}`);
      }
      setPairs(body.pairs ?? []);
      setBase(body.base ?? 'USD');
      setUpdated(body.updated ?? null);
      setDerived(body.derived ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // `TH` already defaults `color` to `color.textMuted` and takes `align` as a prop; this
  // board's headers carry `fontWeight.regular` on top of that (the shelf's shared style is
  // capture-only and still defaults `semibold`), which rides the atom's last-wins spread.
  const thStyle: CSSProperties = { padding: space[6], fontWeight: fontWeight.regular };
  const tdStyle: CSSProperties = { padding: space[6] };

  return (
    <div>
      <Toolbar
        style={{ alignItems: 'baseline', gap: space[8], flexWrap: 'wrap', marginBottom: space[12] }}
        actions={
          <button
            onClick={load}
            style={{
              background: color.surface,
              color: color.text,
              border: `1px solid ${color.border}`,
              padding: `${space[6]}px ${space[14]}px`,
              borderRadius: radius[6],
              fontSize: fontSize[11],
              cursor: 'pointer',
            }}
          >
            ↻ Refresh
          </button>
        }
      >
        <h3 style={{ color: color.accent, margin: 0 }}>
          Forex — major pairs
          <span style={{ color: color.textMuted, fontSize: fontSize[11], fontWeight: fontWeight.regular }}>
            {' '}
            · base {base}
            {updated ? ` · updated ${fmtTime(updated)}` : ''}
          </span>
        </h3>
      </Toolbar>

      {error && <p style={{ color: color.negative, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <Loading />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH style={thStyle}>Pair</TH>
              <TH align="right" style={thStyle}>Rate</TH>
              <TH align="right" style={thStyle}>Inverse</TH>
            </TR>
          </THead>
          <TBody>
            {pairs.map((p) => (
              <TR key={p.pair}>
                <TD style={{ ...tdStyle, fontWeight: fontWeight.bold, color: color.text }}>{p.pair}</TD>
                <TD align="right" style={{ ...tdStyle, color: color.accent }}>{fmtRate(p.rate)}</TD>
                <TD align="right" style={{ ...tdStyle, color: color.textMuted }}>{fmtRate(p.inverse)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {derived && <p style={{ color: color.textMuted, fontSize: fontSize[10], marginTop: space[10] }}>{derived}</p>}
    </div>
  );
}
