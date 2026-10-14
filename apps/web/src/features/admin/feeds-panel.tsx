'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, radius, space } from '@/styles/tokens';
import { fetchFeeds, saveFeeds } from './client';
import { describeSaveFailure } from './save-error';
import {
  ADAPTERS,
  MAX_POLL_SECS,
  MIN_POLL_SECS,
  adapterHint,
  draftFrom,
  healthLine,
  intervalLabel,
  newFeedDraft,
  toSource,
  type FeedDraft,
} from './feeds-draft';

// FeedsPanel is the editor for the sources the worker's poller reads — the panel that owns the
// `feed.poll` definitions the Scheduler panel shows read-only.
//
// It is a REPLACE, not a per-row save, because that is what the endpoint is: one transaction
// (upsert by name, delete the rest) that makes the source set match this list, and the same
// transaction writes each source's poll definition so a feed can never exist unpolled. So the
// panel holds drafts, and Save is the only thing that writes.
//
// What the panel SHOWS and never sends is the poller's own report — `primed`, `owed`,
// `lastStatus`, `lastError`, `consecutiveFailures`. Feed health is unreadable anywhere else, so
// hiding it would leave an operator guessing; sending it back would be a lie about the save.
// That line is drawn in `writableFeeds` (client.ts), not here.
//
// What the panel does NOT own is validation: a url into private space, a name over 64
// characters, a cadence outside the bounds are the api's refusal at the point of entry and, for
// the url, the WORKER's guard on every hop of every poll. The panel offers the shape as a
// placeholder and shows the server's sentence.

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

const labelStyle: React.CSSProperties = {
  color: themeColor.labelTertiary,
  fontSize: fontSize[11],
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 120 }}>
      <span style={labelStyle}>{label}</span>
      {children}
      {hint !== undefined && <span style={{ ...labelStyle, color: themeColor.labelTertiary }}>{hint}</span>}
    </label>
  );
}

export default function FeedsPanel() {
  const [drafts, setDrafts] = useState<FeedDraft[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await fetchFeeds();
      setReadError(null);
      setDrafts((body.feeds ?? []).map((row, i) => draftFrom(row, `feed-${row.id || i}`)));
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'request failed');
      setDrafts(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback((key: string, next: Partial<FeedDraft>) => {
    setDrafts((cur) => (cur ?? []).map((d) => (d.key === key ? { ...d, ...next } : d)));
  }, []);

  const add = useCallback(() => {
    setNote(null);
    setDrafts((cur) => [...(cur ?? []), newFeedDraft(`new-${crypto.randomUUID()}`)]);
  }, []);

  const remove = useCallback((key: string) => {
    setNote(null);
    setDrafts((cur) => (cur ?? []).filter((d) => d.key !== key));
  }, []);

  const save = useCallback(async () => {
    if (drafts === null) return;
    setBusy(true);
    setNote(null);
    try {
      // The answer is the STORED rows, not the request body: the poller's report is only
      // knowable from the store, so the panel re-reads rather than trusting its drafts.
      const body = await saveFeeds(drafts.map(toSource));
      const n = (body.feeds ?? []).length;
      setNote({ ok: true, text: `saved — ${n} feed${n === 1 ? '' : 's'}` });
      await load();
    } catch (err) {
      // The refusal is the server's sentence: it names the field, the duplicate name or the
      // store that is not configured. A status code would tell an operator nothing.
      setNote({ ok: false, text: describeSaveFailure(err) });
    } finally {
      setBusy(false);
    }
  }, [drafts, load]);

  if (readError !== null) {
    return <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>feeds read failed: {readError}</p>;
  }
  if (drafts === null) {
    return <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>loading…</p>;
  }

  const healthy = drafts.filter((d) => d.lastError === '' && d.consecutiveFailures === 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[12], maxWidth: 980 }}>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={save} disabled={busy} style={btnStyle}>{busy ? 'saving…' : 'save'}</button>
        <button onClick={add} disabled={busy} style={btnStyle}>add feed</button>
        <button onClick={() => { setNote(null); load(); }} disabled={busy} style={btnStyle}>reload</button>
        <span style={{ ...labelStyle, color: note === null ? themeColor.labelTertiary : note.ok ? themeColor.green : themeColor.red }}>
          {note === null
            ? `${drafts.length} feed${drafts.length === 1 ? '' : 's'}${
                drafts.length > 0 ? ` · ${healthy} with no reported failure` : ''
              }`
            : note.text}
        </span>
      </div>

      {drafts.length === 0 && (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], margin: 0 }}>
          No feeds. A feed needs a name, a url and a destination channel id; save and the worker creates its
          poll definition in the same transaction, then announces new items there.
        </p>
      )}

      {drafts.map((d) => (
        <div
          key={d.key}
          style={{
            border: `1px solid ${themeColor.separator}`,
            borderRadius: radius[8],
            padding: space[12],
            display: 'flex',
            flexDirection: 'column',
            gap: space[8],
          }}
        >
          <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={d.name}
              onChange={(e) => patch(d.key, { name: e.target.value })}
              placeholder="feed name, e.g. blog"
              style={{ ...inputStyle, width: 220 }}
            />
            <label style={{ display: 'flex', gap: space[4], alignItems: 'center', color: themeColor.labelTertiary, fontSize: fontSize[12] }}>
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={(e) => patch(d.key, { enabled: e.target.checked })}
              />
              enabled
            </label>
            <span style={{ ...labelStyle, marginLeft: 'auto' }}>
              {d.id > 0 ? `#${d.id}` : 'new — not saved yet'}
            </span>
            <button onClick={() => remove(d.key)} style={{ ...btnStyle, color: themeColor.red, borderColor: themeColor.red }}>
              remove
            </button>
          </div>

          <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 320px' }}>
              <Field label="url" hint="http(s), default port, a public host — no localhost, no private literals">
                <input
                  value={d.url}
                  onChange={(e) => patch(d.key, { url: e.target.value })}
                  placeholder="https://example.com/feed.xml"
                  style={inputStyle}
                />
              </Field>
            </div>
            <Field label="adapter" hint={adapterHint(d.adapter)}>
              <select value={d.adapter} onChange={(e) => patch(d.key, { adapter: e.target.value })} style={inputStyle}>
                {ADAPTERS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Field>
            <Field label="channel id" hint="a Discord channel snowflake">
              <input
                value={d.channelId}
                onChange={(e) => patch(d.key, { channelId: e.target.value })}
                style={{ ...inputStyle, width: 200 }}
              />
            </Field>
          </div>

          <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Field label="poll every (seconds)" hint={intervalLabel(d.pollIntervalSecs)}>
              <input
                type="number"
                min={MIN_POLL_SECS}
                max={MAX_POLL_SECS}
                value={d.pollIntervalSecs}
                onChange={(e) => patch(d.key, { pollIntervalSecs: Number(e.target.value) })}
                style={{ ...inputStyle, width: 130 }}
              />
            </Field>
            <Field label="mention role id" hint="optional; a role to ping, never @everyone">
              <input
                value={d.mentionRoleId}
                onChange={(e) => patch(d.key, { mentionRoleId: e.target.value })}
                style={{ ...inputStyle, width: 180 }}
              />
            </Field>
            <Field label="include text" hint="keep only items containing this">
              <input
                value={d.includeText}
                onChange={(e) => patch(d.key, { includeText: e.target.value })}
                style={{ ...inputStyle, width: 160 }}
              />
            </Field>
            <Field label="exclude text" hint="drop items containing this">
              <input
                value={d.excludeText}
                onChange={(e) => patch(d.key, { excludeText: e.target.value })}
                style={{ ...inputStyle, width: 160 }}
              />
            </Field>
          </div>

          <div style={{ flex: '1 1 380px' }}>
            <Field label="announcement" hint={`optional template — {title}, {url} and {link} are substituted · ${d.message.length} / 512 characters`}>
              <textarea
                value={d.message}
                onChange={(e) => patch(d.key, { message: e.target.value })}
                rows={2}
                placeholder="**{title}**\n{url}"
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>
          </div>

          <p style={{ ...labelStyle, margin: 0 }}>
            {healthLine(d)}
            {' · '}
            cadence lives on this feed&apos;s own <code>feed.poll</code> definition — the row the Scheduler panel
            shows read-only as owned by the feeds panel.
          </p>
        </div>
      ))}
    </div>
  );
}
