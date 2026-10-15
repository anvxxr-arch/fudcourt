'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontFamily, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { describeSaveFailure } from './save-error';
import { fetchCustomCommands, saveCustomCommands, type CustomCommand } from './client';
import {
  EMBED_NOTE,
  GRAMMAR_NOTE,
  NORMALISE_NOTE,
  RCE_NOTE,
  VARIABLES,
  fromDraft,
  preview,
  responseKind,
  summarize,
  toDraft,
  triggerProblem,
  unknownPlaceholders,
  type CommandDraft,
} from './commands-view';

const blank = (): CommandDraft => ({
  name: '',
  aliases: '',
  responses: [{ text: '' }],
  allowedRoles: '',
  allowedChannels: '',
  cooldownSeconds: '0',
  deleteTrigger: false,
  reply: true,
  dm: false,
  enabled: true,
});

const label = (text: string): string => `{${text}}`;

export default function CommandsPanel() {
  const [rows, setRows] = useState<CommandDraft[] | null>(null);
  const [stored, setStored] = useState<CustomCommand[]>([]);
  const [dirty, setDirty] = useState(false);
  const [readError, setReadError] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const view = await fetchCustomCommands();
      const cmds = view.commands ?? [];
      setStored(cmds);
      setRows(toDraft(cmds));
      setDirty(false);
      setNote(null);
      setReadError('');
    } catch (err) {
      setReadError(describeSaveFailure(err));
      setRows([]);
      setStored([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const edit = useCallback((i: number, changes: Partial<CommandDraft>) => {
    setRows((prev) => (prev ?? []).map((r, j) => (j === i ? { ...r, ...changes } : r)));
    setDirty(true);
    setNote(null);
  }, []);

  const editResponse = useCallback((i: number, j: number, text: string) => {
    setRows((prev) =>
      (prev ?? []).map((r, k) =>
        k === i ? { ...r, responses: r.responses.map((rp, l) => (l === j ? { ...rp, text } : rp)) } : r,
      ),
    );
    setDirty(true);
    setNote(null);
  }, []);

  const save = useCallback(async () => {
    if (rows === null) return;
    const payload = fromDraft(rows);
    // The api owns validation; this catches the two things worth catching before a round trip.
    const problem = triggerProblem(payload);
    if (problem !== null) {
      setNote({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    try {
      const view = await saveCustomCommands(payload);
      const saved = view.commands ?? [];
      setStored(saved);
      setRows(toDraft(saved));
      setDirty(false);
      setNote({ ok: true, text: `saved ${saved.length} command${saved.length === 1 ? '' : 's'}` });
    } catch (err) {
      setNote({ ok: false, text: describeSaveFailure(err) });
    } finally {
      setBusy(false);
    }
  }, [rows]);

  const list = rows ?? [];
  const stats = summarize(fromDraft(list));

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space[8], flexWrap: 'wrap' }}>
        <span style={labelStyle}>
          {stats.total} command{stats.total === 1 ? '' : 's'}
          {stats.disabled > 0 ? ` · ${stats.disabled} switched off` : ''}
          {stats.embedded > 0 ? ` · ${stats.embedded} carrying an embed` : ''}
        </span>
        <span style={hintStyle}>
          {stored.length} stored · {list.length} in the editor{dirty ? ' · unsaved changes' : ''}
        </span>
        {dirty ? <span style={{ ...hintStyle, color: themeColor.orange }}>not saved yet</span> : null}
      </div>

      <div style={boxStyle}>
        <span style={noteStyle}>{RCE_NOTE}</span>
        <span style={noteStyle}>{GRAMMAR_NOTE}</span>
      </div>

      <div style={boxStyle}>
        <span style={labelStyle}>what a response may name</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${space[4]}px ${space[12]}px` }}>
          {VARIABLES.map((v) => (
            <span key={v.name} style={hintStyle}>
              <code style={codeStyle}>{label(v.name)}</code> {v.what}
            </span>
          ))}
        </div>
      </div>

      {readError !== '' ? (
        <div style={{ ...boxStyle, borderColor: themeColor.red }}>
          <span style={{ ...noteStyle, color: themeColor.red }}>{readError}</span>
          <button style={btnStyle} onClick={() => void load()}>
            retry
          </button>
        </div>
      ) : null}

      {rows === null ? (
        <span style={hintStyle}>loading…</span>
      ) : list.length === 0 ? (
        <span style={hintStyle}>no custom commands yet — add one below and save.</span>
      ) : (
        list.map((row, i) => {
          const missing = row.responses.flatMap((rp) => unknownPlaceholders(rp.text));
          return (
            <div key={row.id ?? `new-${i}`} style={cardStyle}>
              <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ ...labelStyle, fontFamily: fontFamily.mono }}>!{row.name === '' ? '…' : row.name}</span>
                <label style={hintStyle}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => edit(i, { enabled: e.target.checked })}
                  />{' '}
                  answers
                </label>
                <label style={hintStyle}>
                  <input type="checkbox" checked={row.reply} onChange={(e) => edit(i, { reply: e.target.checked })} />{' '}
                  replies to the trigger
                </label>
                <label style={hintStyle}>
                  <input type="checkbox" checked={row.dm} onChange={(e) => edit(i, { dm: e.target.checked })} />{' '}
                  answers in a DM
                </label>
                <label style={hintStyle}>
                  <input
                    type="checkbox"
                    checked={row.deleteTrigger}
                    onChange={(e) => edit(i, { deleteTrigger: e.target.checked })}
                  />{' '}
                  deletes the trigger
                </label>
                <button
                  style={{ ...btnStyle, color: themeColor.red, borderColor: themeColor.red, marginLeft: 'auto' }}
                  onClick={() => {
                    setRows((prev) => (prev ?? []).filter((_, j) => j !== i));
                    setDirty(true);
                  }}
                >
                  remove
                </button>
              </div>

              <div style={gridStyle}>
                <Field label="trigger">
                  <input style={inputStyle} value={row.name} onChange={(e) => edit(i, { name: e.target.value })} />
                </Field>
                <Field label="aliases (comma separated)">
                  <input
                    style={inputStyle}
                    value={row.aliases}
                    onChange={(e) => edit(i, { aliases: e.target.value })}
                    placeholder="rules, r"
                  />
                </Field>
                <Field label="cooldown (seconds, 0–86400)">
                  <input
                    style={inputStyle}
                    value={row.cooldownSeconds}
                    onChange={(e) => edit(i, { cooldownSeconds: e.target.value })}
                  />
                </Field>
                <Field label="allowed role ids (empty = anyone)">
                  <input
                    style={inputStyle}
                    value={row.allowedRoles}
                    onChange={(e) => edit(i, { allowedRoles: e.target.value })}
                  />
                </Field>
                <Field label="allowed channel ids (empty = anywhere)">
                  <input
                    style={inputStyle}
                    value={row.allowedChannels}
                    onChange={(e) => edit(i, { allowedChannels: e.target.value })}
                  />
                </Field>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
                {row.responses.map((rp, j) => (
                  <div key={j} style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: space[8] }}>
                      <span style={hintStyle}>
                        response {j + 1} · {responseKind(rp)}
                        {row.responses.length > 1 ? ' · one is picked at random' : ''}
                      </span>
                      {rp.embed !== undefined && rp.embed !== null ? (
                        <span style={{ ...hintStyle, color: themeColor.labelTertiary }}>
                          embed kept as-is, not editable here
                        </span>
                      ) : null}
                      {row.responses.length > 1 ? (
                        <button
                          style={{ ...btnStyle, padding: `${space[0]}px ${space[8]}px`, marginLeft: 'auto' }}
                          onClick={() => {
                            setRows((prev) =>
                              (prev ?? []).map((r, k) =>
                                k === i ? { ...r, responses: r.responses.filter((_, l) => l !== j) } : r,
                              ),
                            );
                            setDirty(true);
                          }}
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                    <textarea
                      style={areaStyle}
                      value={rp.text}
                      onChange={(e) => editResponse(i, j, e.target.value)}
                      placeholder={`Read ${label('channel')}, ${label('user')}`}
                    />
                    {unknownPlaceholders(rp.text).length > 0 ? (
                      <span style={{ ...hintStyle, color: themeColor.orange }}>
                        sent as written: {unknownPlaceholders(rp.text).map(label).join(' ')}
                      </span>
                    ) : null}
                  </div>
                ))}
                <button
                  style={{ ...btnStyle, alignSelf: 'flex-start' }}
                  onClick={() => {
                    setRows((prev) =>
                      (prev ?? []).map((r, k) => (k === i ? { ...r, responses: [...r.responses, { text: '' }] } : r)),
                    );
                    setDirty(true);
                  }}
                >
                  + response
                </button>
              </div>

              {missing.length > 0 ? (
                <span style={{ ...hintStyle, color: themeColor.labelTertiary }}>
                  preview: {preview(row.responses[0].text)} — the marked tokens are sent as typed, not substituted.
                </span>
              ) : null}
            </div>
          );
        })
      )}

      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          style={btnStyle}
          onClick={() => {
            setRows((prev) => [...(prev ?? []), blank()]);
            setDirty(true);
          }}
        >
          + add command
        </button>
        <button style={busy || !dirty ? { ...btnPrimary, opacity: 0.6 } : btnPrimary} onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? 'saving…' : `Save all ${list.length}`}
        </button>
        <button style={btnStyle} onClick={() => void load()} disabled={busy}>
          reload
        </button>
        {note !== null ? (
          <span style={{ ...hintStyle, color: note.ok ? themeColor.green : themeColor.red }}>{note.text}</span>
        ) : null}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
        <span style={noteStyle}>{NORMALISE_NOTE}</span>
        <span style={noteStyle}>{EMBED_NOTE}</span>
      </div>
    </div>
  );
}

function Field({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 180 }}>
      <span style={hintStyle}>{text}</span>
      {children}
    </label>
  );
}

const containerStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: space[12] };
const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space[12],
  padding: space[12],
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[10],
  background: themeColor.bgBase,
};
const boxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space[4],
  padding: space[12],
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[10],
  background: themeColor.bgSecondary,
};
const gridStyle: React.CSSProperties = { display: 'flex', gap: space[12], flexWrap: 'wrap' };
const labelStyle: React.CSSProperties = {
  color: themeColor.labelPrimary,
  fontSize: fontSize[13],
  fontWeight: fontWeight.semibold,
};
const hintStyle: React.CSSProperties = {
  color: themeColor.labelSecondary,
  fontSize: fontSize[12],
  lineHeight: lineHeight.normal,
};
const noteStyle: React.CSSProperties = { ...hintStyle, color: themeColor.labelTertiary };
const codeStyle: React.CSSProperties = { fontFamily: fontFamily.mono, fontSize: fontSize[12] };
const inputStyle: React.CSSProperties = {
  background: themeColor.bgBase,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[6]}px`,
  fontSize: fontSize[13],
  fontFamily: 'inherit',
};
const areaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: 78,
  resize: 'vertical',
  lineHeight: lineHeight.normal,
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
const btnPrimary: React.CSSProperties = { ...btnStyle, background: themeColor.blue, color: themeColor.labelOnAccent };
