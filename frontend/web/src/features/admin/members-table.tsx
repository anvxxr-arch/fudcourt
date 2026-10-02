'use client';

import { useCallback, useEffect, useState } from 'react';
import { color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { TIER_COLOR } from './palette';

type Row = { id: string; username: string; globalName: string | null; avatar: string | null; tier: string };

export default function MemberTable() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Members are fetched here, not passed down from the server component:
  // a function prop cannot cross the server/client boundary, and fetching
  // here lets the table refresh itself after a role change.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/members', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.detail ?? `HTTP ${res.status}`);
        setRows(null);
        return;
      }
      setError(null);
      setRows(Array.isArray(body.members) ? body.members : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setRows(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async (row: Row, role: 'team' | 'admin', action: 'add' | 'remove') => {
    const key = `${row.id}:${role}:${action}`;
    setBusy(key);
    setNote(null);
    try {
      const res = await fetch('/api/admin/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: row.id, role, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote(`${row.globalName ?? row.username}: ${body.detail ?? `HTTP ${res.status}`}`);
        return;
      }
      await load();
    } catch (err) {
      setNote(`${row.username}: ${err instanceof Error ? err.message : 'request failed'}`);
    } finally {
      setBusy(null);
    }
  }, [load]);

  const actions = (row: Row) => {
    const buttons: React.ReactNode[] = [];
    for (const role of ['team', 'admin'] as const) {
      // An admin outranks a team member, so only offer "+ team" to non-admins.
      if (action0(row, role, 'add')) {
        buttons.push(btn(row, role, 'add', busy, run, `+ ${role}`));
      }
      if (action0(row, role, 'remove')) {
        buttons.push(btn(row, role, 'remove', busy, run, `− ${role}`));
      }
    }
    return buttons;
  };

  return (
    <div>
      {note && <p style={{ color: color.negative, fontSize: fontSize[12], margin: `0 0 ${space[10]}px` }}>{note}</p>}
      {error !== null ? (
        <p style={{ color: color.negative, fontSize: fontSize[12] }}>{error}</p>
      ) : rows === null ? (
        <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>Loading guild members…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: fontSize[12] }}>
          <thead>
            <tr style={{ color: color.textMuted, textAlign: 'left' }}>
              <th style={{ padding: `${space[6]}px ${space[8]}px`, fontWeight: fontWeight.regular }}>user</th>
              <th style={{ padding: `${space[6]}px ${space[8]}px`, fontWeight: fontWeight.regular }}>tier</th>
              <th style={{ padding: `${space[6]}px ${space[8]}px`, fontWeight: fontWeight.regular }}>roles</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} style={{ borderTop: `1px solid ${color.border}` }}>
                <td style={{ padding: `${space[6]}px ${space[8]}px` }}>
                  {row.globalName ?? row.username}
                  {row.globalName && row.globalName !== row.username && (
                    <span style={{ color: color.textMuted }}> ({row.username})</span>
                  )}
                </td>
                <td style={{ padding: `${space[6]}px ${space[8]}px`, color: TIER_COLOR[row.tier] ?? color.text }}>{row.tier}</td>
                <td style={{ padding: `${space[6]}px ${space[8]}px`, display: 'flex', gap: space[6], flexWrap: 'wrap' }}>
                  {actions(row)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function action0(row: Row, role: 'team' | 'admin', action: 'add' | 'remove'): boolean {
  const held = row.tier === role || (role === 'team' && row.tier === 'admin');
  return action === 'add' ? !held : held;
}

function btn(
  row: Row,
  role: 'team' | 'admin',
  action: 'add' | 'remove',
  busy: string | null,
  run: (row: Row, role: 'team' | 'admin', action: 'add' | 'remove') => void,
  label: string,
) {
  const key = `${row.id}:${role}:${action}`;
  const adding = action === 'add';
  return (
    <button
      disabled={busy === key}
      onClick={() => run(row, role, action)}
      style={{
        background: adding ? color.accent : 'transparent',
        color: adding ? color.textOnAccent : color.negative,
        border: `1px solid ${adding ? color.accent : color.negative}`,
        borderRadius: radius[6], padding: `${space[4]}px ${space[10]}px`, fontSize: fontSize[11], cursor: 'pointer',
        fontFamily: 'inherit', opacity: busy === key ? 0.5 : 1,
      }}>
      {label}
    </button>
  );
}
