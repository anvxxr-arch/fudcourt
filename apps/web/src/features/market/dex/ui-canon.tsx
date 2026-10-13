'use client';
import { themeColor, fontSize, fontWeight } from '@/styles/tokens';
import { useT } from '@/lib/i18n/t';
import { MarketTable } from './ui-table';
import type { BoardRow } from './canonical';
import { num, money, pct } from './ui-format';

// These columns come from the CANONICAL API, not from a provider envelope, so
// the row type is flat: the pool read carries identity/liquidity/volume/age and
// the market read carries change/txns/market cap. A row with no market snapshot
// renders em-dashes in those three cells rather than zeros or a hidden column —
// "unreported" and "zero" must not look alike.

const COLUMN_KEYS = [
  { key: 'pair', labelKey: 'col.pair' },
  { key: 'dex', labelKey: 'dex.colDex' },
  { key: 'price', labelKey: 'col.price', align: 'right', numeric: true },
  { key: 'change', labelKey: 'dex.colChange24h', align: 'right', numeric: true },
  { key: 'vol', labelKey: 'dex.colVol24h', align: 'right', numeric: true },
  { key: 'liq', labelKey: 'dex.colLiq', align: 'right', numeric: true },
  { key: 'txns', labelKey: 'dex.colTxns' },
  { key: 'mcap', labelKey: 'dex.colMcap', align: 'right', numeric: true },
  { key: 'age', labelKey: 'dex.colAge' },
  { key: 'chain', labelKey: 'col.chain' },
] as const;

/** Pool age from the canonical RFC3339 stamp, in the same style as the pair feed. */
function ageFromISO(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

function BoardRowViewCells(row: BoardRow) {
  const [base, quote] = row.pair.split('/');
  return [
      <span key="pair">
        <span style={{ color: themeColor.blue, fontWeight: fontWeight.bold }}>{base}</span>
        <span style={{ color: themeColor.labelTertiary }}>/{quote ?? '—'}</span>
      </span>,
      <span key="dex" style={{ color: themeColor.labelTertiary }}>{row.dex}</span>,
      <span key="price" style={{ color: themeColor.labelPrimary }}>{num(row.priceUsd, { prefix: '$' })}</span>,
      <span
        key="change"
        style={{ color: row.change24h == null ? themeColor.labelTertiary : row.change24h >= 0 ? themeColor.green : themeColor.red }}
      >
        {pct(row.change24h)}
      </span>,
      <span key="vol" style={{ color: themeColor.labelPrimary }}>{money(row.volume24h)}</span>,
      <span key="liq" style={{ color: themeColor.labelPrimary }}>{money(row.liquidityUsd)}</span>,
      row.buys == null || row.sells == null ? null : (
        <span key="txns" style={{ color: themeColor.labelTertiary }}>{`${row.buys}/${row.sells}`}</span>
      ),
      <span key="mcap" style={{ color: themeColor.labelPrimary }}>{money(row.marketCapUsd)}</span>,
      <span key="age" style={{ color: themeColor.labelTertiary }}>{ageFromISO(row.createdAt)}</span>,
      <span key="chain" style={{ color: themeColor.labelTertiary }}>{row.chain}</span>,
  ];
}

export function CanonicalBoard({ rows }: { rows: BoardRow[] }) {
  const t = useT();
  const columns = COLUMN_KEYS.map((c) => ({ ...c, label: t(c.labelKey as Parameters<typeof t>[0]) }));
  return (
    <MarketTable
      columns={columns}
      rows={rows.map((r) => ({ key: r.poolId + r.address, cells: BoardRowViewCells(r) }))}
      empty={<p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{t('dex.emptyCanon')}</p>}
      overflowNote={
        rows.length > 100 ? (
          <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: 8 }}>{t('common.showingFirst', { n: 100, total: rows.length })}{t('dex.overflowRaise')}</p>
        ) : undefined
      }
    />
  );
}
