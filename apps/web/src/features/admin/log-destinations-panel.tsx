'use client';

import { useCallback, useEffect, useState } from 'react';
import { fontFamily, fontSize, fontWeight, lineHeight, radius, space, themeColor } from '@/styles/tokens';
import { fetchLogDestinations, saveLogDestination, type LogDestinationsView } from './client';
import { describeSaveFailure } from './save-error';
import {
  CHANNEL_HINT,
  ROUTING_NOTE,
  clearWarning,
  draftFrom,
  intentFor,
  isRouted,
  labelFor,
  noteFor,
  outcomeSentence,
  summarize,
  type Row,
} from './log-destinations-draft';
import { formatWireTime } from './wire-time';

type Note = { text: string; ok: boolean };

/**
 * Activity-log routing: one row per category, each pointing at its own channel.
 *
 * Two facts drive the whole panel, and both come from code that is not here:
 *   • the category set is the api's, sent on every read — this panel never hardcodes it;
 *   • an empty channel DELETES the routing row (the channel is forgotten), while the toggle only
 *     stops delivery. Those are different intents, so the panel offers them as different buttons
 *     and says which one is which before it is pressed.
 *
 * The api validates and names the field in its refusal; the panel shows that sentence rather than
 * pre-empting it. The one local guard is `intentFor` returning "nothing to send", which keeps a
 * no-op write off the wire.
 */
export default function LogDestinationsPanel() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [unlabelled, setUnlabelled] = useState<string[]>([]);
  const [edit, setEdit] = useState<Record<string, { channelId: string; enabled: boolean }>>({});
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = (await fetchLogDestinations()) as LogDestinationsView;
      const draft = draftFrom(body);
      setRows(draft.rows);
      setUnlabelled(draft.unlabelled);
      setEdit(
        Object.fromEntries(
          draft.rows.map((r) => [r.category, { channelId: r.channelId, enabled: r.enabled }]),
        ),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setRows(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** The row as the operator has it edited, against the row the api stores. */
  const edited = (r: Row): Row => ({
    ...r,
    channelId: edit[r.category]?.channelId ?? r.channelId,
    enabled: edit[r.category]?.enabled ?? r.enabled,
  });

  const patch = (category: string, next: Partial<{ channelId: string; enabled: boolean }>) => {
    setEdit((e) => ({ ...e, [category]: { ...(e[category] ?? { channelId: '', enabled: true }), ...next } }));
  };

  const send = useCallback(
    async (row: Row) => {
      const intent = intentFor(row);
      if (intent.kind === 'none') return;
      setBusy(row.category);
      try {
        const body = await saveLogDestination(intent.body);
        setNotes((n) => ({ ...n, [row.category]: { text: outcomeSentence(body), ok: true } }));
        // The server's answer is not re-read by the api (it echoes), so re-read it here: the row
        // must show what is STORED, not what was sent.
        await load();
      } catch (err) {
        setNotes((n) => ({ ...n, [row.category]: { text: describeSaveFailure(err), ok: false } }));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const all = rows ?? [];
  const stats = summarize(all);

  return (
    <div style={containerStyle}>
      <div style={headStyle}>
        <span style={titleStyle}>Activity log routing</span>
        <button type="button" style={btnStyle} onClick={() => void load()}>
          refresh
        </button>
        <span style={noteStyle}>
          {rows === null ? 'loading…' : `${stats.routed} of ${stats.total} routed`}
          {stats.off > 0 ? ` · ${stats.off} switched off` : ''}
        </span>
      </div>

      {error !== null && <p style={{ ...noteStyle, color: themeColor.red }}>{error}</p>}
      {unlabelled.length > 0 && (
        <p style={{ ...noteStyle, color: themeColor.orange }}>
          the api routes {unlabelled.join(', ')} — this dashboard has no description for{' '}
          {unlabelled.length === 1 ? 'that category' : 'those categories'} yet; it is routed as sent.
        </p>
      )}

      {all.map((stored) => {
        const row = edited(stored);
        const intent = intentFor(row);
        const routed = isRouted(row);
        const note = notes[row.category];
        return (
          <div key={row.category} style={rowStyle}>
            <div style={leftStyle}>
              <span style={labelStyle}>{labelFor(row.category)}</span>
              {noteFor(row.category) !== null && <span style={subStyle}>{noteFor(row.category)}</span>}
              {stored.stored !== null && (
                <span style={subStyle}>last set {formatWireTime(stored.stored.updatedAt)}</span>
              )}
            </div>

            <input
              style={inputStyle}
              value={row.channelId}
              placeholder="unrouted"
              aria-label={`${labelFor(row.category)} channel id`}
              onChange={(e) => patch(row.category, { channelId: e.target.value })}
            />

            <label style={toggleStyle}>
              <input
                type="checkbox"
                checked={row.enabled}
                disabled={!routed}
                onChange={(e) => patch(row.category, { enabled: e.target.checked })}
              />
              delivery {routed ? (row.enabled ? 'on' : 'off') : '— unrouted'}
            </label>

            <div style={actionStyle}>
              {intent.kind === 'none' ? (
                <span style={subStyle}>{row.stored === null ? 'unrouted' : 'saved'}</span>
              ) : (
                <button
                  type="button"
                  style={intent.kind === 'clear' ? btnDangerStyle : btnStyle}
                  disabled={busy === row.category}
                  onClick={() => void send(row)}
                >
                  {busy === row.category ? '…' : intent.kind === 'clear' ? 'clear (deletes the row)' : 'save'}
                </button>
              )}
            </div>

            {intent.kind === 'clear' && <p style={warnStyle}>{clearWarning(row.category)}</p>}
            {note !== undefined && (
              <p style={{ ...noteStyle, color: note.ok ? themeColor.green : themeColor.red }}>{note.text}</p>
            )}
          </div>
        );
      })}

      <p style={noteStyle}>{ROUTING_NOTE}</p>
      <p style={noteStyle}>
        The channel field wants {CHANNEL_HINT}. The bot reaches it with its own permissions — a channel
        it cannot post in fails quietly, once per event, and the failure never breaks the action being
        logged.
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

const headStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: space[8], flexWrap: 'wrap' };

const titleStyle: React.CSSProperties = {
  fontSize: fontSize[13],
  fontWeight: fontWeight.semibold,
  color: themeColor.labelPrimary,
};

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(120px, 1fr) minmax(140px, 1fr) auto auto',
  gap: space[8],
  alignItems: 'center',
  borderTop: `1px solid ${themeColor.separator}`,
  paddingTop: space[8],
};

const leftStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: space[4] };

const labelStyle: React.CSSProperties = {
  fontSize: fontSize[13],
  color: themeColor.labelPrimary,
};

const subStyle: React.CSSProperties = { fontSize: fontSize[11], color: themeColor.labelTertiary };

const inputStyle: React.CSSProperties = {
  background: themeColor.bgBase,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[6]}px`,
  fontSize: fontSize[13],
  fontFamily: fontFamily.mono,
};

const toggleStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space[4],
  fontSize: fontSize[12],
  color: themeColor.labelSecondary,
};

const actionStyle: React.CSSProperties = { display: 'flex', justifyContent: 'flex-end' };

const btnStyle: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${themeColor.blue}`,
  color: themeColor.blue,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[10]}px`,
  fontSize: fontSize[12],
  cursor: 'pointer',
};

const btnDangerStyle: React.CSSProperties = { ...btnStyle, borderColor: themeColor.red, color: themeColor.red };

const noteStyle: React.CSSProperties = {
  fontSize: fontSize[12],
  color: themeColor.labelSecondary,
  margin: 0,
  lineHeight: lineHeight.normal,
};

const warnStyle: React.CSSProperties = {
  ...noteStyle,
  gridColumn: '1 / -1',
  color: themeColor.orange,
};
