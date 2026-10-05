'use client';
import { getJSON } from '@/lib/fetch';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { Toolbar } from '@/ui/toolbar';
import { fmtRate, fmtTime } from '@/lib/format';
/**
 * Forex family (keyless, public) -- the contract behind the /market/forex
 * section.
 *
 * Upstream is open.er-api.com (exchangerate-api free tier): one keyless GET
 * returns 160+ rates against a single base. It publishes once a day (ECB-fed),
 * hence the long TTL. `api.frankfurter.app` was the first choice but now answers
 * `301 Moved Permanently` (measured), so this uses the endpoint that actually
 * resolves.
 *
 * The hub shows curated MAJOR pairs, not all 160 -- a 160-row dump is a mirror
 * of the provider, a curated board is a view. Pairs are DERIVED locally from the
 * USD base rates (`EUR/USD = 1 / rate(EUR)`); the route labels that as
 * `derived`, never presenting the provider as having shipped these pairs.
 */

/** Fixed upstream: exchangerate-api free feed (public, keyless, GET-only). */
export const FOREX_UPSTREAM = 'https://open.er-api.com/v6/latest/USD';

/** The feed republishes daily; 5 min is ample and keeps us far under any limit. */
export const FOREX_TTL_MS = 300_000;

export type ForexPairSpec = {
  pair: string;
  base: string;
  quote: string;
  /** true when the USD rate is the QUOTE, so the displayed rate is its reciprocal. */
  invert: boolean;
};

/** Curated majors + Asia (IDR included). */
export const FOREX_PAIRS: readonly ForexPairSpec[] = [
  { pair: 'EUR/USD', base: 'EUR', quote: 'USD', invert: true },
  { pair: 'GBP/USD', base: 'GBP', quote: 'USD', invert: true },
  { pair: 'AUD/USD', base: 'AUD', quote: 'USD', invert: true },
  { pair: 'NZD/USD', base: 'NZD', quote: 'USD', invert: true },
  { pair: 'USD/JPY', base: 'USD', quote: 'JPY', invert: false },
  { pair: 'USD/CHF', base: 'USD', quote: 'CHF', invert: false },
  { pair: 'USD/CAD', base: 'USD', quote: 'CAD', invert: false },
  { pair: 'USD/CNY', base: 'USD', quote: 'CNY', invert: false },
  { pair: 'USD/SGD', base: 'USD', quote: 'SGD', invert: false },
  { pair: 'USD/HKD', base: 'USD', quote: 'HKD', invert: false },
  { pair: 'USD/IDR', base: 'USD', quote: 'IDR', invert: false },
  { pair: 'USD/MYR', base: 'USD', quote: 'MYR', invert: false },
  { pair: 'USD/THB', base: 'USD', quote: 'THB', invert: false },
  { pair: 'USD/PHP', base: 'USD', quote: 'PHP', invert: false },
  { pair: 'USD/INR', base: 'USD', quote: 'INR', invert: false },
  { pair: 'USD/KRW', base: 'USD', quote: 'KRW', invert: false },
];

export type ForexPair = { pair: string; base: string; quote: string; rate: number; inverse: number };

/** Build one displayed pair from the USD-base rate map; null if the leg is absent. */
export function buildPair(spec: ForexPairSpec, rates: Record<string, number>): ForexPair | null {
  const usdRate = rates[spec.invert ? spec.base : spec.quote];
  if (typeof usdRate !== 'number' || !Number.isFinite(usdRate) || usdRate <= 0) return null;
  const rate = spec.invert ? 1 / usdRate : usdRate;
  return { pair: spec.pair, base: spec.base, quote: spec.quote, rate, inverse: 1 / rate };
}


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

  // `TH` already defaults `color` to `color.labelTertiary` and takes `align` as a prop; this
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
              background: color.bgSecondary,
              color: color.labelPrimary,
              border: `1px solid ${color.separator}`,
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
        <h3 style={{ color: color.blue, margin: 0 }}>
          Forex — major pairs
          <span style={{ color: color.labelTertiary, fontSize: fontSize[11], fontWeight: fontWeight.regular }}>
            {' '}
            · base {base}
            {updated ? ` · updated ${fmtTime(updated)}` : ''}
          </span>
        </h3>
      </Toolbar>

      {error && <p style={{ color: color.red, fontSize: fontSize[12] }}>{error}</p>}

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
                <TD style={{ ...tdStyle, fontWeight: fontWeight.bold, color: color.labelPrimary }}>{p.pair}</TD>
                <TD align="right" style={{ ...tdStyle, color: color.blue }}>{fmtRate(p.rate)}</TD>
                <TD align="right" style={{ ...tdStyle, color: color.labelTertiary }}>{fmtRate(p.inverse)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {derived && <p style={{ color: color.labelTertiary, fontSize: fontSize[11], marginTop: space[8] }}>{derived}</p>}
    </div>
  );
}
