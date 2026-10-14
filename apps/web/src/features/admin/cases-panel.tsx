'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, radius, space } from '@/styles/tokens';
import { fetchCases, type ModerationCase } from './client';
import { formatWireTime } from './wire-time';

// CasesPanel is the read-only moderation-case log: the SAME rows a Discord
// `/history` shows, read through the Go api. It answers the product spec's
// "case history must be visible from Discord AND Dashboard" by reading one
// shared table — never a second copy.
//
// The filter box accepts a Discord user id (a member's history) or a case
// number (#42 / 42 → one case). An empty filter lists the most recent cases.

const inputStyle: React.CSSProperties = {
  background: themeColor.bgBase,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.labelTertiary}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[6]}px`,
  fontSize: fontSize[13],
  width: 280,
};

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  color: themeColor.blue,
  border: `1px solid ${themeColor.blue}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[10]}px`,
  fontSize: fontSize[12],
  cursor: 'pointer',
};

/** parseQuery turns the filter box into an api query: `#42`/`42` → number, else target. */
export function parseQuery(raw: string): { number?: number; target?: string } {
  const v = raw.trim().replace(/^#/, '');
  if (v === '') return {};
  if (/^\d+$/.test(v)) return { number: Number(v) };
  return { target: v };
}

export default function CasesPanel() {
  const [cases, setCases] = useState<ModerationCase[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    try {
      const body = await fetchCases({ ...parseQuery(q), limit: 25 });
      setError(null);
      setCases(body.cases ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setCases(null);
    }
  }, []);

  useEffect(() => { load(''); }, [load]);

  if (error) return <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>case log read failed: {error}</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[12] }}>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(filter); }}
          placeholder="user id, or #case number"
          style={inputStyle}
        />
        <button onClick={() => load(filter)} style={btnStyle}>filter</button>
        <button onClick={() => { setFilter(''); load(''); }} style={btnStyle}>recent</button>
      </div>

      {cases === null ? (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>loading…</p>
      ) : cases.length === 0 ? (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>no cases.</p>
      ) : (
        <table style={{ fontSize: fontSize[12], borderCollapse: 'collapse', maxWidth: 900 }}>
          <thead>
            <tr style={{ color: themeColor.labelTertiary, textAlign: 'left' }}>
              <th style={{ padding: '2px 12px 2px 0' }}>#</th>
              <th style={{ padding: '2px 12px 2px 0' }}>action</th>
              <th style={{ padding: '2px 12px 2px 0' }}>target</th>
              <th style={{ padding: '2px 12px 2px 0' }}>moderator</th>
              <th style={{ padding: '2px 12px 2px 0' }}>reason</th>
              <th style={{ padding: '2px 12px 2px 0' }}>source</th>
              <th style={{ padding: '2px 0' }}>created</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id}>
                <td style={{ padding: '2px 12px 2px 0', color: themeColor.blue }}>{c.caseNumber}</td>
                <td style={{ padding: '2px 12px 2px 0' }}>{c.action}</td>
                <td style={{ padding: '2px 12px 2px 0', color: themeColor.labelTertiary }}>{c.targetUserId}</td>
                <td style={{ padding: '2px 12px 2px 0', color: themeColor.labelTertiary }}>{c.moderatorUserId}</td>
                <td style={{ padding: '2px 12px 2px 0' }}>{c.reason || '—'}</td>
                <td style={{ padding: '2px 12px 2px 0', color: themeColor.labelTertiary }}>{c.source}</td>
                <td style={{ padding: '2px 0', color: themeColor.labelTertiary }}>{formatWireTime(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
