'use client';

/**
 * capability-board.tsx — the "what does venue X support" table (plan Phase 3).
 *
 * Reads `VenueCapability` rows straight from `capabilities.ts` and renders ONE
 * COLUMN PER `OrderType`, every cell a stated `✓`/`✕`. Nothing is hidden: an
 * order type the venue lacks is a visible `✕`, so the trader sees the gap rather
 * than an absent button. The `nativeTwap`/`nativeVwap`/`nativeIceberg` columns
 * say WHO slices — `venue` when the venue does it natively, `executor` when the
 * FUDCourt engine has to (PRD §28). A row for a pairing the taxonomy does not
 * carry cannot exist, because the matrix is built from `VENUE_MARKET_TYPES`.
 *
 * Every value comes from the token SSOT, so the design gate stays green.
 */
import { color, fontSize, fontWeight } from '@/styles/tokens';
import { NO_VALUE } from '@/features/trade/client';
import { capabilityBoard } from '@/features/trade/model';
import { MARKET_TYPE_BY_ID, VENUE_BY_ID, type MarketType, type VenueId } from '@/features/trade/model';
import { Card } from '@/ui/card';
import { DataTable } from '@/ui/data-table';
import { Notice } from '@/ui/notice';
import { Perm } from '@/ui/perm';


/** Who slices a TWAP/VWAP/iceberg here: the venue natively, or the executor engine. */
function Slicer({ native }: { native: boolean }) {
  return <span style={{ color: native ? color.green : color.labelTertiary }}>{native ? 'venue' : 'executor'}</span>;
}

/** Margin modes, or the em dash for a market type with no margin concept. */
function MarginModes({ modes }: { modes: { cross: boolean; isolated: boolean } | null }) {
  if (modes === null) return <span style={{ color: color.labelTertiary }}>{NO_VALUE}</span>;
  const on = [modes.cross ? 'cross' : null, modes.isolated ? 'isolated' : null].filter((v): v is string => v !== null);
  return <span>{on.length === 0 ? NO_VALUE : on.join(' · ')}</span>;
}

export function CapabilityBoard({ venue, marketType }: { venue?: VenueId; marketType?: MarketType }) {
  const { columns, rows } = capabilityBoard();
  const shown = rows.filter(
    (row) => (venue === undefined || row.venue === venue) && (marketType === undefined || row.marketType === marketType),
  );

  const head = [
    'Venue',
    'Market',
    'Instrument',
    ...columns.map((c) => c.label),
    'TWAP',
    'VWAP',
    'Iceberg',
    'Leverage',
    'Margin',
    'Reduce-only',
    'Post-only',
  ];

  return (
    <Card
      title="Venue capability board"
      subtitle="what each venue actually supports — every order type stated, a ✕ is a stated limitation, never an absent button"
    >
      {shown.length === 0 ? (
        <Notice>No venue serves this market type — the taxonomy states no such pairing, so the board offers none.</Notice>
      ) : (
        <DataTable
          head={head}
          rows={shown.map((row) => ({
            cells: [
              <span key="v" style={{ fontWeight: fontWeight.semibold }}>{VENUE_BY_ID[row.venue].label}</span>,
              <span key="m" style={{ color: color.labelTertiary }}>{MARKET_TYPE_BY_ID[row.marketType].label}</span>,
              <span key="i" style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{row.instrumentId}</span>,
              ...columns.map((c) => <Perm key={c.id} value={row.orderTypes[c.id]} tone="capability" />),
              <Slicer key="twap" native={row.nativeTwap} />,
              <Slicer key="vwap" native={row.nativeVwap} />,
              <Slicer key="iceberg" native={row.nativeIceberg} />,
              <Perm key="lev" value={row.leverage} tone="capability" />,
              <MarginModes key="mm" modes={row.marginModes} />,
              <Perm key="ro" value={row.reduceOnly} tone="capability" />,
              <Perm key="po" value={row.postOnly} tone="capability" />,
            ],
          }))}
        />
      )}
      <p style={{ margin: '10px 0 0', fontSize: fontSize[11], color: color.labelTertiary }}>
        {shown.length} row{shown.length === 1 ? '' : 's'} · one per venue × market type the taxonomy serves ·{' '}
        <span style={{ color: color.labelTertiary }}>TWAP/VWAP/Iceberg read</span> <Slicer native={false} />{' '}
        <span style={{ color: color.labelTertiary }}>when the venue has no native slice and FUDCourt slices it itself.</span>
      </p>
    </Card>
  );
}
