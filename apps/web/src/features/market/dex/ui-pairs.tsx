'use client';
import { themeColor, fontSize, fontWeight } from '@/styles/tokens';
import { useT } from '@/lib/i18n/t';
import { MarketTable } from './ui-table';
import type { DexPair } from './client';
import { num, money, pct, age, win } from './ui-format';

// The cells are rebuilt on each render (cheap: ten formatted strings); the
// skeleton's Row is memo'd on the cells array, so a filter-only re-render of
// an unchanged row's cells still reconciles without re-laying-out the table.
function PairRowViewCells(pair: DexPair) {
  const t24 = win(pair.txns, 'h24');
  const ch24 = win(pair.priceChange, 'h24');
  return [
      <span key="pair">
        <span style={{ color: themeColor.blue, textDecoration: 'none', fontWeight: fontWeight.bold }}>
          {pair.baseToken?.symbol || '—'}
        </span>
        <span style={{ color: themeColor.labelTertiary }}>/{pair.quoteToken?.symbol || '—'}</span>
      </span>,
      <span key="dex" style={{ color: themeColor.labelTertiary }}>{pair.dexId || '—'}</span>,
      <span key="price" style={{ color: themeColor.labelPrimary }}>{num(pair.priceUsd, { prefix: '$' })}</span>,
      <span key="chg" style={{ color: ch24 == null ? themeColor.labelTertiary : ch24 >= 0 ? themeColor.green : themeColor.red }}>{pct(ch24)}</span>,
      <span key="vol" style={{ color: themeColor.labelPrimary }}>{money(win(pair.volume, 'h24') ?? null)}</span>,
      <span key="liq" style={{ color: themeColor.labelPrimary }}>{money(pair.liquidity?.usd ?? null)}</span>,
      t24?.buys == null || t24?.sells == null ? null : (
        <span key="txns" style={{ color: themeColor.labelTertiary }}>{`${t24.buys}/${t24.sells}`}</span>
      ),
      <span key="mcap" style={{ color: themeColor.labelPrimary }}>{money(pair.marketCap ?? null)}</span>,
      <span key="age" style={{ color: themeColor.labelTertiary }}>{age(pair.pairCreatedAt)}</span>,
      <span key="labels" style={{ color: themeColor.labelTertiary }}>
        {pair.labels && pair.labels.length ? pair.labels.join(',') : '—'}
      </span>,
  ];
}

export function PairsTable({ rows, visible }: { rows: DexPair[]; visible: DexPair[] }) {
  const t = useT();
  const columns = [
    { key: 'pair', label: t('col.pair') },
    { key: 'dex', label: t('dex.colDex') },
    { key: 'price', label: t('col.price'), align: 'right', numeric: true },
    { key: 'chg', label: t('dex.colChange24h'), align: 'right', numeric: true },
    { key: 'vol', label: t('dex.colVol24h'), align: 'right', numeric: true },
    { key: 'liq', label: t('dex.colLiq'), align: 'right', numeric: true },
    { key: 'txns', label: t('dex.colTxns') },
    { key: 'mcap', label: t('dex.colMcap'), align: 'right', numeric: true },
    { key: 'age', label: t('dex.colAge') },
    { key: 'labels', label: t('dex.colLabels') },
  ] as const;
  return (
    <MarketTable
      columns={columns}
      rows={visible.map((p) => ({
        key: p.pairAddress,
        cells: PairRowViewCells(p),
      }))}
      empty={<p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{t('dex.emptyPairs')}</p>}
      overflowNote={
        visible.length > 100 ? (
          <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[11], marginTop: 8 }}>{t('common.showingFirst', { n: 100, total: visible.length })}{t('dex.overflowNarrow')}</p>
        ) : undefined
      }
    />
  );
}
