'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { themeColor, fontFamily, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { Table, TBody, TD, TH, THead, TR } from '@/ui/table';
import { fetchAuditEntries, type AuditEntry } from './client';
import {
  ACTOR_NOTE,
  DEFAULT_WINDOW,
  FILTER_NOTE,
  GAP_NOTE,
  WINDOWS,
  actorLabel,
  describeChange,
  diffSnapshots,
  resourceLabel,
  sourceLabel,
  summarize,
  typesIn,
  windowNote,
} from './audit-view';
import { formatWireTime } from './wire-time';

/**
 * The audit log. READ-ONLY, like the assignment log, and for the same reason: this table is evidence
 * the api writes as it acts — there is no route that edits it.
 *
 * What it answers is "what changed about the bot, who changed it, and from where". The change column
 * is the point of the panel: `before`/`after` are snapshots, and a configuration replacement (join
 * roles, role panels, custom commands) arrives as two whole arrays — one change to read, not a
 * synthetic diff of two lists. A row with no snapshot says so rather than showing an empty column,
 * because "no snapshot recorded" and "nothing changed" are different facts.
 *
 * Two things this panel refuses to imply: that the trail is complete (a failed audit write is only
 * logged — the change stands without its evidence), and that the resource-type filter validates its
 * input (it does not: an unknown name is an empty list, which looks like silence).
 */
const CHANGE_LINES = 3;

export default function AuditPanel() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_WINDOW);
  const [filter, setFilter] = useState<string>('');
  // Resource types seen so far. The filter is server-side and the column is free-form, so the options
  // are what has actually appeared — accumulated, because a filtered page only shows its own type.
  const [seen, setSeen] = useState<string[]>([]);

  const load = useCallback(async (wantLimit: number, wantFilter: string) => {
    try {
      const body = await fetchAuditEntries(wantLimit, wantFilter);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      setRows(entries);
      setError(null);
      setSeen((prev) => [...new Set([...prev, ...entries.map((e) => e.resourceType)])].sort());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setRows(null);
    }
  }, []);

  useEffect(() => {
    void load(limit, filter);
  }, [load, limit, filter]);

  const all = rows ?? [];
  const stats = summarize(all);
  const options = [...new Set([...seen, ...typesIn(all)])].sort();

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: fontSize[13], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary }}>
          Audit log
        </span>
        <label style={labelStyle}>
          window
          <select style={inputStyle} value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {WINDOWS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          resource
          <select style={inputStyle} value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">all</option>
            {options.map((t) => (
              <option key={t} value={t}>
                {resourceLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" style={btnStyle} onClick={() => void load(limit, filter)}>
          refresh
        </button>
        <span style={noteStyle}>
          {stats.total} shown · {windowNote(limit)}
        </span>
      </div>

      {error !== null && <p style={{ ...noteStyle, color: themeColor.red, margin: `${space[8]}px 0 0` }}>{error}</p>}

      {stats.actors.length > 1 && (
        <div style={boxStyle}>
          <span style={{ fontSize: fontSize[12], fontWeight: fontWeight.semibold, color: themeColor.labelPrimary }}>
            changes by actor
          </span>
          {stats.actors.map((a) => (
            <div key={a.label} style={{ fontSize: fontSize[12], color: themeColor.labelSecondary }}>
              {a.label} — {a.count}
            </div>
          ))}
        </div>
      )}

      <Table style={{ marginTop: space[8] }}>
        <THead>
          <TR style={{ borderBottom: `1px solid ${themeColor.separator}` }}>
            <TH>when</TH>
            <TH>actor</TH>
            <TH>action</TH>
            <TH>resource</TH>
            <TH>source</TH>
            <TH>change</TH>
          </TR>
        </THead>
        <TBody>
          {rows === null ? (
            <TR>
              <TD colSpan={6} style={noteStyle}>
                {error === null ? 'loading…' : 'no data'}
              </TD>
            </TR>
          ) : all.length === 0 ? (
            <TR>
              <TD colSpan={6} style={noteStyle}>
                {filter === ''
                  ? 'nothing recorded yet'
                  : `nothing recorded for ${resourceLabel(filter)} — or that is not a name the bot writes`}
              </TD>
            </TR>
          ) : (
            all.map((e) => {
              const changes = diffSnapshots(e.before, e.after);
              const hasSnapshots = e.before !== undefined || e.after !== undefined;
              return (
                <Fragment key={e.id}>
                  <TR>
                    <TD style={{ color: themeColor.labelSecondary, whiteSpace: 'nowrap' }}>
                      {formatWireTime(e.createdAt)}
                    </TD>
                    <TD style={{ color: themeColor.labelPrimary }}>{actorLabel(e)}</TD>
                    <TD mono>{e.action}</TD>
                    <TD style={{ color: themeColor.labelSecondary }}>
                      {resourceLabel(e.resourceType)}
                      {e.resourceId === '' ? '' : ` · ${e.resourceId}`}
                    </TD>
                    <TD style={{ color: themeColor.labelSecondary }}>{sourceLabel(e.source)}</TD>
                    <TD style={{ color: themeColor.labelSecondary, whiteSpace: 'nowrap' }}>
                      {!hasSnapshots
                        ? 'no snapshot'
                        : changes.length === 0
                          ? 'no change'
                          : `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`}
                    </TD>
                  </TR>
                  {changes.length > 0 && (
                    <TR key={`${e.id}-diff`}>
                      <TD colSpan={6} style={{ paddingBottom: space[6] }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
                          {changes.slice(0, CHANGE_LINES).map((c, i) => (
                            <span key={`${c.key}-${i}`} style={diffStyle}>
                              {describeChange(c)}
                            </span>
                          ))}
                          {changes.length > CHANGE_LINES && (
                            <span style={{ ...diffStyle, color: themeColor.labelTertiary }}>
                              +{changes.length - CHANGE_LINES} more
                            </span>
                          )}
                        </div>
                      </TD>
                    </TR>
                  )}
                </Fragment>
              );
            })
          )}
        </TBody>
      </Table>

      <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
        <span style={noteStyle}>{GAP_NOTE}</span>
        <span style={noteStyle}>{FILTER_NOTE}</span>
        <span style={noteStyle}>{ACTOR_NOTE}</span>
        <span style={noteStyle}>
          {resIdNote} · a window of {DEFAULT_WINDOW} is the api's own default and 100 its ceiling.
        </span>
      </div>
    </div>
  );
}

const resIdNote =
  'Resource ids are read-only labels (a category, a resource name) and are truncated by the api at 128 characters';

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

const diffStyle: React.CSSProperties = {
  fontFamily: fontFamily.mono,
  fontSize: fontSize[12],
  color: themeColor.labelSecondary,
  wordBreak: 'break-all',
};
