'use client';

/**
 * Every tracked central bank (plan Phase 7) — `/economy/central-bank`.
 *
 * One BIS call fills the whole board. A bank BIS carries no observation for keeps
 * `rate: null` and is named in the failures — the row still renders, because "we
 * track this bank but BIS is quiet" is a different fact from "this bank does not
 * exist".
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { color, fontSize, space } from '@/styles/tokens';
import { fetchCentralBanks, formatDate, formatValue, type CentralBanksEnvelope } from '@/features/economy/client';
import { Card, DataTable, ECONOMY_NAV, ErrorState, Loading, PageHeader } from '@/features/economy/ui/parts';

export default function CentralBankIndex() {
  const [data, setData] = useState<CentralBanksEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchCentralBanks(ac.signal)
      .then((d) => !ac.signal.aborted && setData(d))
      .catch((e) => !ac.signal.aborted && setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  const byRegion = useMemo(() => {
    const m = new Map<string, CentralBanksEnvelope['banks'][number][]>();
    for (const b of data?.banks ?? []) {
      const list = m.get(b.region) ?? [];
      list.push(b);
      m.set(b.region, list);
    }
    return m;
  }, [data]);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: `${space[24]}px ${space[16]}px` }}>
      <PageHeader
        title="Central Banks"
        description="Policy rates from BIS WS_CBPOL, daily. One upstream call for every tracked area; a bank BIS does not carry is shown with an em dash rather than omitted."
        nav={ECONOMY_NAV}
      />

      {error && <ErrorState title="Could not load central banks" detail={error} />}
      {!data && !error && <Loading what="central banks" />}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[14] }}>
          {[...byRegion.entries()].map(([region, banks]) => (
            <Card key={region} title={region} subtitle={`${banks.length} authorities`}>
              <DataTable
                head={['Bank', 'Policy rate', 'As of', 'Area']}
                rows={banks.map((b) => ({
                  href: `/economy/central-bank/${b.slug}`,
                  cells: [
                    b.name,
                    <span key="r" style={{ color: b.rate === null ? color.textMuted : color.text }}>{b.rate === null ? '—' : `${formatValue(b.rate, 2)}%`}</span>,
                    <span key="d" style={{ color: color.textMuted }}>{formatDate(b.date)}</span>,
                    <span key="a" style={{ color: color.textMuted }}>{b.area}</span>,
                  ],
                }))}
              />
            </Card>
          ))}
          {data.failed.length > 0 && (
            <ErrorState title={`${data.failed.length} area(s) unresolved`} detail={data.failed.map((f) => `${f.symbol}: ${f.reason}`).join(' · ')} />
          )}
          <p style={{ fontSize: fontSize[11], color: color.textMuted }}>{data.derived}</p>
        </div>
      )}
    </main>
  );
}
