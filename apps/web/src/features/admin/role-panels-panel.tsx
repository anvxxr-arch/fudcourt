'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontFamily, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { describeSaveFailure } from './save-error';
import { fetchRolePanels, saveRolePanels, type RolePanel } from './client';
import {
  DEFAULT_STYLE,
  LIMITS,
  MESSAGE_ID_NOTE,
  OPTION_STYLES,
  OWNERSHIP_NOTE,
  PANEL_KINDS,
  PANEL_MODES,
  POSTER_GAP,
  deadReactionOptions,
  describeKind,
  describeMode,
  duplicateRoleIds,
  emojiKey,
  fromDraft,
  groups,
  normalisedEmojiOptions,
  panelProblem,
  summarize,
  toDraft,
  type OptionDraft,
  type PanelDraft,
} from './role-panels-view';

const blankOption = (): OptionDraft => ({ roleId: '', label: '', emoji: '', style: DEFAULT_STYLE, exclusiveGroup: '' });

const blank = (): PanelDraft => ({
  id: '',
  channelId: '',
  messageId: '',
  title: '',
  description: '',
  kind: 'button',
  mode: 'toggle',
  enabled: true,
  options: [blankOption()],
});

export default function RolePanelsPanel() {
  const [rows, setRows] = useState<PanelDraft[] | null>(null);
  const [stored, setStored] = useState<RolePanel[]>([]);
  const [dirty, setDirty] = useState(false);
  const [readError, setReadError] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const view = await fetchRolePanels();
      const panels = view.panels ?? [];
      setStored(panels);
      setRows(toDraft(panels));
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

  const edit = useCallback((i: number, changes: Partial<PanelDraft>) => {
    setRows((prev) => (prev ?? []).map((r, j) => (j === i ? { ...r, ...changes } : r)));
    setDirty(true);
    setNote(null);
  }, []);

  const editOption = useCallback((i: number, j: number, changes: Partial<OptionDraft>) => {
    setRows((prev) =>
      (prev ?? []).map((r, k) =>
        k === i ? { ...r, options: r.options.map((o, l) => (l === j ? { ...o, ...changes } : o)) } : r,
      ),
    );
    setDirty(true);
    setNote(null);
  }, []);

  const save = useCallback(async () => {
    if (rows === null) return;
    const payload = fromDraft(rows);
    const problem = panelProblem(payload);
    if (problem !== null) {
      setNote({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    try {
      const view = await saveRolePanels(payload);
      const saved = view.panels ?? [];
      setStored(saved);
      setRows(toDraft(saved));
      setDirty(false);
      setNote({ ok: true, text: `saved ${saved.length} panel${saved.length === 1 ? '' : 's'}` });
    } catch (err) {
      setNote({ ok: false, text: describeSaveFailure(err) });
    } finally {
      setBusy(false);
    }
  }, [rows]);

  const list = rows ?? [];
  const stats = summarize(list);

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: space[8], flexWrap: 'wrap' }}>
        <span style={labelStyle}>
          {stats.total} panel{stats.total === 1 ? '' : 's'}
          {Object.entries(stats.byKind).length > 0
            ? ` · ${Object.entries(stats.byKind)
                .map(([k, n]) => `${n} ${k}`)
                .join(', ')}`
            : ''}
          {stats.disabled > 0 ? ` · ${stats.disabled} switched off` : ''}
        </span>
        <span style={hintStyle}>
          {stored.length} stored · {list.length} in the editor{dirty ? ' · unsaved changes' : ''}
        </span>
        {dirty ? <span style={{ ...hintStyle, color: themeColor.orange }}>not saved yet</span> : null}
      </div>

      <div style={boxStyle}>
        <span style={noteStyle}>{OWNERSHIP_NOTE}</span>
        <span style={noteStyle}>{MESSAGE_ID_NOTE}</span>
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
        <span style={hintStyle}>no role panels yet — add one below and save.</span>
      ) : (
        list.map((row, i) => {
          const dead = deadReactionOptions(row);
          const pasted = normalisedEmojiOptions(row);
          const dupes = duplicateRoleIds(row);
          const groupList = groups(row);
          return (
            <div key={`${row.id}-${i}`} style={cardStyle}>
              <div style={{ display: 'flex', gap: space[8], flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ ...labelStyle, fontFamily: fontFamily.mono }}>{row.id === '' ? '(no id)' : row.id}</span>
                <label style={hintStyle}>
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) => edit(i, { enabled: e.target.checked })}
                  />{' '}
                  live
                </label>
                <span style={{ ...hintStyle, color: themeColor.labelTertiary }}>
                  {row.options.length}/{LIMITS.options} options
                </span>
                {row.messageId !== '' ? (
                  <span style={{ ...hintStyle, fontFamily: fontFamily.mono }}>message {row.messageId}</span>
                ) : null}
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
                <Field label="id (<= 64 chars, unique)">
                  <input style={inputStyle} value={row.id} onChange={(e) => edit(i, { id: e.target.value })} />
                </Field>
                <Field label="channel id (empty = anywhere)">
                  <input
                    style={inputStyle}
                    value={row.channelId}
                    onChange={(e) => edit(i, { channelId: e.target.value })}
                  />
                </Field>
                <Field label="kind">
                  <select style={inputStyle} value={row.kind} onChange={(e) => edit(i, { kind: e.target.value })}>
                    {PANEL_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="mode">
                  <select style={inputStyle} value={row.mode} onChange={(e) => edit(i, { mode: e.target.value })}>
                    {PANEL_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="title">
                  <input style={inputStyle} value={row.title} onChange={(e) => edit(i, { title: e.target.value })} />
                </Field>
                <Field label="description">
                  <input
                    style={inputStyle}
                    value={row.description}
                    onChange={(e) => edit(i, { description: e.target.value })}
                  />
                </Field>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
                <span style={hintStyle}>{describeKind(row.kind)}</span>
                <span style={hintStyle}>{describeMode(row.mode)}</span>
              </div>

              {row.kind === 'button' || row.kind === 'select' ? (
                <span style={{ ...hintStyle, color: themeColor.orange }}>{POSTER_GAP}</span>
              ) : null}

              {row.mode === 'exclusive' ? (
                <span style={hintStyle}>
                  groups: {groupList.map((g) => `${g.name} ${g.count} option${g.count === 1 ? '' : 's'}`).join(' · ')}{' '}
                  {groupList.length === 1
                    ? '— one group only, so exclusive behaves like single for this panel.'
                    : '— a pick revokes only the options sharing its group.'}
                </span>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
                {row.options.map((o, j) => {
                  const normalised = emojiKey(o.emoji);
                  const mismatch = o.emoji.trim() !== '' && normalised !== o.emoji;
                  return (
                    <div key={j} style={optionRowStyle}>
                      <div style={gridStyle}>
                        <Field label="role id">
                          <input
                            style={inputStyle}
                            value={o.roleId}
                            onChange={(e) => editOption(i, j, { roleId: e.target.value })}
                          />
                        </Field>
                        <Field label="label (<= 100)">
                          <input
                            style={inputStyle}
                            value={o.label}
                            onChange={(e) => editOption(i, j, { label: e.target.value })}
                          />
                        </Field>
                        <Field label="emoji (reaction panels)">
                          <input
                            style={inputStyle}
                            value={o.emoji}
                            onChange={(e) => editOption(i, j, { emoji: e.target.value })}
                          />
                        </Field>
                        <Field label="style">
                          <select
                            style={inputStyle}
                            value={o.style}
                            onChange={(e) => editOption(i, j, { style: e.target.value })}
                          >
                            {OPTION_STYLES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {row.mode === 'exclusive' ? (
                          <Field label="exclusive group (blank = ungrouped)">
                            <input
                              style={inputStyle}
                              value={o.exclusiveGroup}
                              onChange={(e) => editOption(i, j, { exclusiveGroup: e.target.value })}
                            />
                          </Field>
                        ) : null}
                        <button
                          style={{ ...btnStyle, alignSelf: 'flex-end', color: themeColor.red, borderColor: themeColor.red }}
                          onClick={() => {
                            setRows((prev) =>
                              (prev ?? []).map((r, k) =>
                                k === i ? { ...r, options: r.options.filter((_, l) => l !== j) } : r,
                              ),
                            );
                            setDirty(true);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                      {mismatch ? (
                        <span style={{ ...hintStyle, color: themeColor.orange }}>
                          matched as <code style={codeStyle}>{normalised}</code> — the bot compares the emoji exactly,
                          so a pasted custom emoji is normalised to name:id.
                        </span>
                      ) : null}
                      {dead.includes(j) ? (
                        <span style={{ ...hintStyle, color: themeColor.red }}>
                          no emoji — a reaction panel can never fire this option.
                        </span>
                      ) : null}
                      {dupes.includes(o.roleId.trim()) ? (
                        <span style={{ ...hintStyle, color: themeColor.red }}>
                          role {o.roleId.trim()} appears more than once — the api refuses duplicates in one panel.
                        </span>
                      ) : null}
                    </div>
                  );
                })}
                <button
                  style={{ ...btnStyle, alignSelf: 'flex-start' }}
                  onClick={() => {
                    setRows((prev) =>
                      (prev ?? []).map((r, k) => (k === i ? { ...r, options: [...r.options, blankOption()] } : r)),
                    );
                    setDirty(true);
                  }}
                >
                  + option
                </button>
              </div>
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
          + add panel
        </button>
        <button
          style={busy || !dirty ? { ...btnPrimary, opacity: 0.6 } : btnPrimary}
          onClick={() => void save()}
          disabled={busy || !dirty}
        >
          {busy ? 'saving…' : `Save all ${list.length}`}
        </button>
        <button style={btnStyle} onClick={() => void load()} disabled={busy}>
          reload
        </button>
        {note !== null ? (
          <span style={{ ...hintStyle, color: note.ok ? themeColor.green : themeColor.red }}>{note.text}</span>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label: text, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 150 }}>
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
const optionRowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space[4],
  padding: space[8],
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  background: themeColor.bgSecondary,
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
const gridStyle: React.CSSProperties = { display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' };
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
