'use client';

/**
 * accounts.tsx — the trade domain's connected-account surface (plan Phase 17).
 *
 *   ConnectedAccountsStrip  a compact strip a market board renders under itself
 *   TradeAccountsView       the full view: every connected venue, its masked key,
 *                           the withdrawal-permission warning, and a capability
 *                           summary ("supports X, Y, Z — not W") read from the
 *                           Phase 3 matrix, so the account page and the board
 *                           can never disagree about what a venue does.
 *
 * HONESTY. The strip renders only what `/api/executor/accounts` returns: the
 * masked key, never a secret (the API does not return one). A key granted
 * withdrawal rights is WARNED about, never hidden. Positions and balances are
 * declared by the venue binding but not served by a route yet, so the view says
 * so instead of printing a zero balance — a connected-but-unqueried account is
 * unknown, not empty.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { alpha, color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { bindingFor } from '@/features/trade/adapters';
import { capabilityOrderTypeSplit, capabilitiesForVenue } from '@/features/trade/model';
import {
  errorMessage,
  fetchTradeAccounts,
  formatUsd,
  NO_VALUE,
  TRADE_NAV,
  venueOfExchange,
  type TradeAccountLite,
} from '@/features/trade/client';
import type { VenueCapability } from '@/features/trade/model';
import { MARKET_TYPE_BY_ID, VENUE_BY_ID } from '@/features/trade/model';
import { Card, DataTable, ErrorState, Loading, Notice, PageHeader, Value } from '@/features/trade/ui/parts';

type Panel = { accounts: TradeAccountLite[]; error: string | null; loading: boolean };

/** Load the connected accounts once; a 401 is the ordinary "not connected" state. */
function useAccounts(): Panel {
  const [panel, setPanel] = useState<Panel>({ accounts: [], error: null, loading: true });
  useEffect(() => {
    const ac = new AbortController();
    fetchTradeAccounts(ac.signal)
      .then((accounts) => !ac.signal.aborted && setPanel({ accounts, error: null, loading: false }))
      .catch((err) => !ac.signal.aborted && setPanel({ accounts: [], error: errorMessage(err), loading: false }));
    return () => ac.abort();
  }, []);
  return panel;
}

/** A tri-state venue permission: `null` means the venue does not report it. */
function Perm({ value }: { value: boolean | null }) {
  if (value === null) return <span style={{ color: color.labelTertiary }} title="the venue does not report this flag">{NO_VALUE}</span>;
  return <span style={{ color: value ? color.green : color.labelTertiary }}>{value ? '✓' : '✕'}</span>;
}

/** "supports X, Y, Z — not W", from the exhaustive capability record. */
function capabilityLine(capability: VenueCapability): string {
  const { supports, missing } = capabilityOrderTypeSplit(capability);
  const yes = supports.map((e) => e.label).join(', ');
  const no = missing.map((e) => e.label).join(', ');
  const head = yes === '' ? 'no order types' : `supports ${yes}`;
  return no === '' ? head : `${head} — not ${no}`;
}

// ---------------------------------------------------------------------------
// The strip — rendered under every market board
// ---------------------------------------------------------------------------

export function ConnectedAccountsStrip() {
  const { accounts, error, loading } = useAccounts();

  return (
    <Card
      title="Connected accounts"
      subtitle="your exchange keys, never ours — the masked key is the only key the API returns"
      right={
        <Link href="/trade/accounts" style={{ fontSize: fontSize[11], color: color.blue, textDecoration: 'none' }}>
          manage accounts →
        </Link>
      }
    >
      {error ? (
        <ErrorState title="Accounts unavailable" detail={error} />
      ) : loading ? (
        <Loading what="accounts" />
      ) : accounts.length === 0 ? (
        <Notice>
          No venue account connected. Connect one in the executor and it appears here —{' '}
          <Link href="/executor/accounts" style={{ color: color.blue }}>connect a venue →</Link>
        </Notice>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: space[12] }}>
          {accounts.map((account) => (
            <div key={account.id} style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
              <span style={{ fontSize: fontSize[12], color: color.labelPrimary, fontWeight: fontWeight.semibold }}>
                {account.label}
                <span style={{ color: color.labelTertiary, fontWeight: fontWeight.regular }}> · {account.exchange}</span>
              </span>
              <span style={{ fontSize: fontSize[11], color: color.labelTertiary }}>{account.apiKeyMasked}</span>
              <span style={{ fontSize: fontSize[11], color: account.revokedAt === null ? color.labelTertiary : color.red }}>
                {account.revokedAt === null ? `health ${account.health}` : 'revoked'}
              </span>
              {account.permissions.withdraw === true && (
                <span style={{ fontSize: fontSize[11], color: color.red, fontWeight: fontWeight.bold }}>
                  ⚠ key has withdrawal permission — remove it on the venue
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The full view — the margin account view and /trade/accounts
// ---------------------------------------------------------------------------

function AccountTable({ accounts }: { accounts: TradeAccountLite[] }) {
  return (
    <DataTable
      head={['Label', 'Venue', 'Type', 'Key', 'Read', 'Spot', 'Futures', 'Withdraw']}
      rows={accounts.map((account) => {
        const venue = venueOfExchange(account.exchange);
        return {
          cells: [
            account.label,
            venue === null ? account.exchange : `${VENUE_BY_ID[venue].label} · ${VENUE_BY_ID[venue].type}`,
            account.revokedAt === null ? account.health : 'revoked',
            <span key="k" style={{ color: color.labelTertiary }}>{account.apiKeyMasked}</span>,
            <Perm key="r" value={account.permissions.read} />,
            <Perm key="s" value={account.permissions.spotTrade} />,
            <Perm key="f" value={account.permissions.futuresTrade} />,
            <span key="w" style={{ color: account.permissions.withdraw === true ? color.red : color.labelPrimary }}>
              <Perm value={account.permissions.withdraw} />
              {account.permissions.withdraw === true && (
                <span style={{ fontWeight: fontWeight.bold }}> · remove it</span>
              )}
            </span>,
          ],
        };
      })}
    />
  );
}

/** A venue's rows from the Phase 3 matrix, one line each, plus the read-channel gap. */
function VenueCapabilitySummary({ exchange }: { exchange: string }) {
  const venue = venueOfExchange(exchange);
  if (venue === null) {
    return (
      <p style={{ margin: 0, fontSize: fontSize[11], color: color.labelTertiary }}>
        {exchange} is not a venue the trade domain can route to yet, so it has no capability row.
      </p>
    );
  }
  const rows = capabilitiesForVenue(venue);
  const binding = bindingFor(venue);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
      {rows.map((row) => (
        <div key={row.marketType}>
          <span style={{ fontSize: fontSize[11], color: color.labelPrimary, fontWeight: fontWeight.semibold }}>
            {MARKET_TYPE_BY_ID[row.marketType].label}
          </span>
          <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary, lineHeight: lineHeight.normal }}>
            {capabilityLine(row)}
          </p>
        </div>
      ))}
      <p style={{ margin: `${space[4]}px 0 0`, fontSize: fontSize[11], color: color.labelTertiary }}>
        reads · positions {binding.reads.positions.live ? binding.reads.positions.path : `not served yet (${binding.reads.positions.path})`}
        {' · '}balances {binding.reads.balances.live ? binding.reads.balances.path : `not served yet (${binding.reads.balances.path})`}
        {' · '}account {binding.reads.account.path}
      </p>
    </div>
  );
}

export function TradeAccountsView({ note, showPortfolio = true }: { note?: string; showPortfolio?: boolean }) {
  const { accounts, error, loading } = useAccounts();

  return (
    <>
      {showPortfolio && (
        <Card title="Portfolio" subtitle="one account per connected venue — figures appear once a venue answers">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: space[12] }}>
            <Value label="Connected venues" value={loading ? NO_VALUE : String(accounts.length)} />
            <Value label="Equity" value={formatUsd(null)} tone="muted" hint="No positions/balances route yet, so equity is unknown, not zero." />
            <Value label="Available" value={formatUsd(null)} tone="muted" />
            <Value label="Positions" value={NO_VALUE} tone="muted" hint="The positions read is declared but not served by a route yet." />
          </div>
        </Card>
      )}

      {note !== undefined && (
        <div style={{ marginTop: space[12] }}>
          <Notice>{note}</Notice>
        </div>
      )}

      <div style={{ marginTop: space[12] }}>
        <Card title="Connected accounts" subtitle="masked key · venue type · permissions — a withdrawal-capable key is warned, never hidden">
          {error ? (
            <ErrorState title="Accounts unavailable" detail={error} />
          ) : loading ? (
            <Loading what="accounts" />
          ) : accounts.length === 0 ? (
            <Notice>
              No venue account connected yet. BYOK lives in the executor (Phase 18 reuses its sealed key) —{' '}
              <Link href="/executor/accounts" style={{ color: color.blue }}>connect a venue →</Link>
            </Notice>
          ) : (
            <AccountTable accounts={accounts} />
          )}
        </Card>
      </div>

      {accounts.length > 0 && (
        <div style={{ display: 'grid', gap: space[12], gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginTop: space[12] }}>
          {accounts.map((account) => (
            <Card key={account.id} title={`${account.label} — capability`} subtitle="what this venue supports, and what FUDCourt covers for it">
              <VenueCapabilitySummary exchange={account.exchange} />
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/** The /trade/accounts page body (Phase 17). */
export function TradeAccountsPage() {
  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px`, background: color.bgBase, color: color.labelPrimary }}>
      <PageHeader
        title="Trade accounts"
        description="Every venue your trading connects to: the masked key, the permission the venue reports, and a capability summary read from the same matrix the boards use."
        nav={TRADE_NAV}
      />
      <TradeAccountsView />
    </main>
  );
}
