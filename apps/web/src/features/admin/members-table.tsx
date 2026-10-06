'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { TIER_COLOR } from './palette';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { fetchMembers, setMemberRole, type MemberRow as Row, type MemberRole } from './client';

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
      const body = await fetchMembers();
      setError(null);
      setRows(Array.isArray(body.members) ? body.members : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setRows(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async (row: Row, role: MemberRole, action: 'add' | 'remove') => {
    const key = `${row.id}:${role}:${action}`;
    setBusy(key);
    setNote(null);
    try {
      await setMemberRole(row.id, role, action);
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
      {note && <p style={{ color: themeColor.red, fontSize: fontSize[12], margin: `0 0 ${space[8]}px` }}>{note}</p>}
      {error !== null ? (
        <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>{error}</p>
      ) : rows === null ? (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>Loading guild members…</p>
      ) : (
        <Table>
          <THead>
            <TR style={{ borderBottom: 'none' }}>
              <TH style={{ padding: `${space[8]}px ${space[8]}px`, fontWeight: fontWeight.regular }}>user</TH>
              <TH style={{ padding: `${space[8]}px ${space[8]}px`, fontWeight: fontWeight.regular }}>tier</TH>
              <TH style={{ padding: `${space[8]}px ${space[8]}px`, fontWeight: fontWeight.regular }}>roles</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map(row => (
              <TR key={row.id} style={{ borderBottom: 'none', borderTop: `1px solid ${themeColor.separator}` }}>
                <TD style={{ padding: `${space[8]}px ${space[8]}px` }}>
                  {row.globalName ?? row.username}
                  {row.globalName && row.globalName !== row.username && (
                    <span style={{ color: themeColor.labelTertiary }}> ({row.username})</span>
                  )}
                </TD>
                <TD style={{ padding: `${space[8]}px ${space[8]}px`, color: TIER_COLOR[row.tier] ?? themeColor.labelPrimary }}>{row.tier}</TD>
                <TD style={{ padding: `${space[8]}px ${space[8]}px`, display: 'flex', gap: space[8], flexWrap: 'wrap' }}>
                  {actions(row)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}

function action0(row: Row, role: MemberRole, action: 'add' | 'remove'): boolean {
  const held = row.tier === role || (role === 'team' && row.tier === 'admin');
  return action === 'add' ? !held : held;
}

function btn(
  row: Row,
  role: MemberRole,
  action: 'add' | 'remove',
  busy: string | null,
  run: (row: Row, role: MemberRole, action: 'add' | 'remove') => void,
  label: string,
) {
  const key = `${row.id}:${role}:${action}`;
  const adding = action === 'add';
  return (
    <button
      disabled={busy === key}
      onClick={() => run(row, role, action)}
      style={{
        background: adding ? themeColor.blue : 'transparent',
        color: adding ? themeColor.labelOnAccent : themeColor.red,
        border: `1px solid ${adding ? themeColor.blue : themeColor.red}`,
        borderRadius: radius[8], padding: `${space[4]}px ${space[8]}px`, fontSize: fontSize[11], cursor: 'pointer',
        fontFamily: 'inherit', opacity: busy === key ? 0.5 : 1,
      }}>
      {label}
    </button>
  );
}
