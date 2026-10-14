'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontFamily, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { fetchRoleAssignments, type RoleAssignment } from './client';
import {
  DEFAULT_LIMIT,
  LIMITS,
  SOURCE_NOTE,
  failuresOnly,
  groupFailures,
  reasonOf,
  sourceLabel,
  summarize,
  windowNote,
} from './role-assignments-view';
import { formatWireTime } from './wire-time';

/**
 * The role-assignment log. READ-ONLY: the api exposes a GET and nothing else, because this table is
 * written by the BOT as it acts — it is evidence, not configuration.
 *
 * Its reason to exist is the failures. "Why didn't this member get the role?" has no answer anywhere
 * else, and the answer is the bot's own sentence: a hierarchy refusal, a Discord error, a hierarchy
 * lookup that never completed. The panel therefore does not summarise those sentences; it makes them
 * findable, and it answers the one question a flat list cannot: whether the SAME role keeps failing.
 */
export default function RoleAssignmentsPanel() {
  const [rows, setRows] = useState<RoleAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [onlyFailures, setOnlyFailures] = useState(false);

  const load = useCallback(async (want: number) => {
    try {
      const body = await fetchRoleAssignments(want);
      setRows(Array.isArray(body.assignments) ? body.assignments : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setRows(null);
    }
  }, []);

  useEffect(() => {
    void load(limit);
  }, [load, limit]);

  const all = rows ?? [];
  const shown = onlyFailures ? failuresOnly(all) : all;
  const stats = summarize(all);
  const groups = groupFailures(all);

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary }}>
          Role assignment log
        </span>
        <label style={labelStyle}>
          window
          <select style={inputStyle} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...labelStyle, gap: space[4] }}>
          <input type="checkbox" checked={onlyFailures} onChange={(e) => setOnlyFailures(e.target.checked)} />
          failures only
        </label>
        <button type="button" style={btnStyle} onClick={() => void load(limit)}>
          refresh
        </button>
        <span style={noteStyle}>
          {stats.total} shown · {stats.failed} failed
        </span>
      </div>

      {error !== null && <p style={{ ...noteStyle, color: themeColor.red, margin: `${space[8]}px 0 0` }}>{error}</p>}

      {groups.length > 0 && (
        <div style={{ ...boxStyle, borderColor: themeColor.red }}>
          <span style={{ fontSize: fontSize[12], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary }}>
            {groups.length === 1 ? 'one role keeps failing' : `${groups.length} roles keep failing`}
          </span>
          {groups.slice(0, 5).map((g) => (
            <div key={g.roleId} style={{ fontSize: fontSize[12], color: themeColor.labelSecondary }}>
              <code style={codeStyle}>{g.roleId}</code> — failed {g.count}× · {g.reason || 'no reason recorded'} · last{' '}
              {formatWireTime(g.lastAt)}
            </div>
          ))}
          <span style={noteStyle}>
            The bot refuses an impossible assignment on every attempt rather than giving up, so a role above its own
            position fails once per join. Fix the role order, or switch the rule off.
          </span>
        </div>
      )}

      <Table style={{ marginTop: space[8] }}>
        <THead>
          <TR style={{ borderBottom: `1px solid ${themeColor.separator}` }}>
            <TH>when</TH>
            <TH>status</TH>
            <TH>source</TH>
            <TH>action</TH>
            <TH>member</TH>
            <TH>role</TH>
            <TH>reason</TH>
            <TH align="right">#</TH>
          </TR>
        </THead>
        <TBody>
          {shown.length === 0 ? (
            <TR>
              <TD colSpan={8} style={{ color: themeColor.labelTertiary, padding: `${space[8]}px 0` }}>
                {rows === null
                  ? 'loading…'
                  : onlyFailures
                    ? 'no failed assignment in this window'
                    : 'no assignment recorded yet'}
              </TD>
            </TR>
          ) : (
            shown.map((a) => (
              <TR key={a.id}>
                <TD style={{ color: themeColor.labelSecondary, whiteSpace: 'nowrap' }}>{formatWireTime(a.createdAt)}</TD>
                <TD>
                  <span
                    style={{
                      color: a.status === 'failed' ? themeColor.red : themeColor.green,
                      fontWeight: fontWeight.semibold,
                    }}
                  >
                    {a.status}
                  </span>
                </TD>
                <TD style={{ color: themeColor.labelSecondary }}>{sourceLabel(a.source)}</TD>
                <TD style={{ color: themeColor.labelSecondary }}>{a.action}</TD>
                <TD mono style={{ color: themeColor.labelSecondary }}>
                  {a.userId}
                </TD>
                <TD mono style={{ color: themeColor.labelSecondary }}>
                  {a.roleId}
                </TD>
                <TD style={{ color: reasonOf(a) ? themeColor.labelPrimary : themeColor.labelTertiary }}>
                  {reasonOf(a) || '—'}
                </TD>
                <TD align="right" style={{ color: themeColor.labelTertiary }}>
                  {a.id}
                </TD>
              </TR>
            ))
          )}
        </TBody>
      </Table>

      <p style={noteStyle}>
        Every grant and revoke the bot attempted, successes included — the only record that answers &ldquo;why
        didn&rsquo;t this member get the role?&rdquo;. {windowNote(limit)}. A failure&rsquo;s reason is the bot&rsquo;s
        own sentence: the hierarchy check&rsquo;s refusal, Discord&rsquo;s error, or a hierarchy lookup that never
        completed.
      </p>
      <p style={noteStyle}>
        Sources: {Object.entries(SOURCE_NOTE).map(([k, v]) => `${sourceLabel(k)} — ${v}`).join('; ')}. A source outside
        that set is refused by the api, so none can appear here.
      </p>
      <p style={noteStyle}>
        Row numbers are stable — this table is append-only, and nothing rewrites it. (An autorole rule&rsquo;s id is
        the opposite: it is reassigned on every save.)
      </p>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space[8],
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: space[12],
};

const boxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space[4],
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: space[8],
  background: themeColor.bgTertiary,
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space[6],
  fontSize: fontSize[12],
  color: themeColor.labelSecondary,
};

const inputStyle: React.CSSProperties = {
  padding: `${space[4]}px ${space[6]}px`,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  background: themeColor.bgBase,
  color: themeColor.labelPrimary,
  fontSize: fontSize[13],
  fontFamily: 'inherit',
};

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${themeColor.blue}`,
  color: themeColor.blue,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[10]}px`,
  fontSize: fontSize[12],
  cursor: 'pointer',
};

const noteStyle: React.CSSProperties = {
  fontSize: fontSize[12],
  color: themeColor.labelSecondary,
  margin: 0,
  lineHeight: lineHeight.normal,
};

const codeStyle: React.CSSProperties = {
  fontFamily: fontFamily.mono,
  fontSize: fontSize[12],
  color: themeColor.labelPrimary,
};
