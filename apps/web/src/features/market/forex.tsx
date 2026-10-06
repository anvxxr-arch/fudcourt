'use client';
import { getJSON } from '@/lib/fetch';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { Toolbar } from '@/ui/toolbar';
import { fmtRate, fmtTime } from '@/lib/format';
import type { ForexPair } from './forex-pairs';
/**
 * Forex board UI (client) — pure pair data lives in './forex-pairs'
 * (server-safe; the API route imports from there, never from this module).
 */
export {
  FOREX_PAIRS,
  FOREX_TTL_MS,
  FOREX_UPSTREAM,
  buildPair,
} from './forex-pairs';
export type { ForexPair, ForexPairSpec } from './forex-pairs';
/** Board envelope rendered by `forex-ui.tsx`. */
export type ForexBoardEnvelope = {
  pairs?: ForexPair[];
  base?: string;
  updated?: number | null;
  derived?: string;
  error?: string;
  detail?: string;
};
/** Transport for the forex board. URL construction lives here; state stays in the view. */
export function fetchForex(): Promise<ForexBoardEnvelope> {
  return getJSON<ForexBoardEnvelope>('/api/market/forex', { cache: 'no-store' });
}
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
      const body = await fetchForex();
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
  // `TH` already defaults `color` to `themeColor.labelTertiary` and takes `align` as a prop; this
  // board's headers carry `fontWeight.regular` on top of that (the shelf's shared style is
  // capture-only and still defaults `semibold`), which rides the atom's last-wins spread.
  const thStyle: CSSProperties = { padding: space[8], fontWeight: fontWeight.regular };
  const tdStyle: CSSProperties = { padding: space[8] };
  return (
    <div>
      <Toolbar
        style={{ alignItems: 'baseline', gap: space[8], flexWrap: 'wrap', marginBottom: space[12] }}
        actions={
          <button
            onClick={load}
            style={{
              background: themeColor.bgSecondary,
              color: themeColor.labelPrimary,
              border: `1px solid ${themeColor.separator}`,
              padding: `${space[8]}px ${space[12]}px`,
              borderRadius: radius[8],
              fontSize: fontSize[11],
              cursor: 'pointer',
            }}
          >
            ↻ Refresh
          </button>
        }
      >
        <h3 style={{ color: themeColor.blue, margin: 0 }}>
          Forex — major pairs
          <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], fontWeight: fontWeight.regular }}>
            {' '}
            · base {base}
            {updated ? ` · updated ${fmtTime(updated)}` : ''}
          </span>
        </h3>
      </Toolbar>
      {error && <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>{error}</p>}
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
                <TD style={{ ...tdStyle, fontWeight: fontWeight.bold, color: themeColor.labelPrimary }}>{p.pair}</TD>
                <TD align="right" style={{ ...tdStyle, color: themeColor.blue }}>{fmtRate(p.rate)}</TD>
                <TD align="right" style={{ ...tdStyle, color: themeColor.labelTertiary }}>{fmtRate(p.inverse)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {derived && <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>{derived}</p>}
    </div>
  );
}
