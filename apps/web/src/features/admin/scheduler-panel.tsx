'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, radius, space } from '@/styles/tokens';
import { fetchSchedules, saveSchedules } from './client';
import { describeSaveFailure } from './save-error';
import {
  JOB_KINDS,
  PAYLOAD_FIELDS,
  SCHEDULE_KINDS,
  SCHEDULER_CONFLICT,
  TIMEZONE_HINTS,
  draftFrom,
  expressionHint,
  newDraft,
  payloadValue,
  reportLine,
  scheduleHint,
  setPayloadValue,
  toDefinition,
  type Draft,
} from './scheduler-draft';

// SchedulerPanel is the editor for the scheduler's own job definitions — the rows the worker's
// tick materializes into `jobs`, the same durable queue everything else uses.
//
// It is a REPLACE, not a per-row save, because that is what the endpoint is: one transaction
// that makes the panel's rows match this list, keyed on name. So the panel holds drafts, and
// Save is the only thing that writes.
//
// Two rules the panel does NOT own, on purpose:
//   • WHAT MAY BE SENT. `readOnly` rows (the feeds' `feed.poll` definitions) are shown and
//     never sent — the Go side derives ownership from `job_kind` and a collision is a 409.
//     That filter lives in `writableDefinitions` (client.ts), not here.
//   • WHAT A FIELD MAY HOLD. A blank name, a 30-second interval, a `once` instant in the past
//     and a cron in a zone the worker does not know are all the SERVER's refusals, with a
//     message naming the field. The panel shows that message rather than keeping a second copy
//     of the rules that could drift from the one that stores the row.

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

export default function SchedulerPanel() {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const body = await fetchSchedules();
      setReadError(null);
      setDrafts((body.definitions ?? []).map((row, i) => draftFrom(row, `row-${row.id || i}`)));
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'request failed');
      setDrafts(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback((key: string, next: Partial<Draft>) => {
    setDrafts((cur) => (cur ?? []).map((d) => (d.key === key ? { ...d, ...next } : d)));
  }, []);

  /** patchPayload writes one payload field. `setPayloadValue` is the immutable setter the
   *  draft module owns, so the panel does not grow a second way to shape a payload. */
  const patchPayload = useCallback((key: string, field: string, value: string) => {
    setDrafts((cur) => (cur ?? []).map((d) => (d.key === key ? setPayloadValue(d, field, value) : d)));
  }, []);

  const add = useCallback(() => {
    setNote(null);
    setDrafts((cur) => [...(cur ?? []), newDraft(`new-${crypto.randomUUID()}`)]);
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
      const body = await saveSchedules(drafts.map(toDefinition));
      const mine = (body.definitions ?? []).filter((d) => !d.readOnly).length;
      setNote({ ok: true, text: `saved — this panel now has ${mine} definition${mine === 1 ? '' : 's'}` });
      await load();
    } catch (err) {
      // The refusal is the server's sentence, not a status code: a 409 names the definition
      // and the panel that owns it, a 400 names the field that is wrong.
      setNote({ ok: false, text: describeSaveFailure(err, SCHEDULER_CONFLICT) });
    } finally {
      setBusy(false);
    }
  }, [drafts, load]);

  if (readError !== null) {
    return <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>scheduler read failed: {readError}</p>;
  }
  if (drafts === null) {
    return <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>loading…</p>;
  }

  const mine = drafts.filter((d) => !d.readOnly).length;
  const theirs = drafts.length - mine;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[12], maxWidth: 980 }}>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={save} disabled={busy} style={btnStyle}>{busy ? 'saving…' : 'save'}</button>
        <button onClick={add} disabled={busy} style={btnStyle}>add definition</button>
        <button onClick={() => { setNote(null); load(); }} disabled={busy} style={btnStyle}>reload</button>
        <span style={{ ...labelStyle, color: note === null ? themeColor.labelTertiary : note.ok ? themeColor.green : themeColor.red }}>
          {note === null
            ? `${mine} definition${mine === 1 ? '' : 's'}${theirs > 0 ? ` · ${theirs} owned by another panel` : ''}`
            : note.text}
        </span>
      </div>

      {drafts.length === 0 && (
        <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12], margin: 0 }}>
          No definitions. A scheduled message needs a channel id and its text; save and the worker&apos;s next
          tick starts running it.
        </p>
      )}

      {drafts.map((d) => {
        const fields = PAYLOAD_FIELDS[d.jobKind] ?? [];
        return (
          <div
            key={d.key}
            style={{
              border: `1px solid ${themeColor.separator}`,
              borderRadius: radius[8],
              padding: space[12],
              display: 'flex',
              flexDirection: 'column',
              gap: space[8],
              background: d.readOnly ? themeColor.bgSecondary : 'transparent',
            }}
          >
            <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap' }}>
              {d.readOnly ? (
                <span style={{ color: themeColor.labelPrimary, fontSize: fontSize[13] }}>{d.name}</span>
              ) : (
                <input
                  value={d.name}
                  onChange={(e) => patch(d.key, { name: e.target.value })}
                  placeholder="definition name, e.g. standup"
                  style={{ ...inputStyle, width: 260 }}
                />
              )}
              <label style={{ display: 'flex', gap: space[4], alignItems: 'center', color: themeColor.labelTertiary, fontSize: fontSize[12] }}>
                <input
                  type="checkbox"
                  checked={d.enabled}
                  disabled={d.readOnly}
                  onChange={(e) => patch(d.key, { enabled: e.target.checked })}
                />
                enabled
              </label>
              <span style={{ ...labelStyle, marginLeft: 'auto' }}>
                {d.readOnly
                  ? `owned by the ${d.owner} panel — not editable here`
                  : d.id > 0
                    ? `#${d.id}`
                    : 'new — not saved yet'}
              </span>
              {!d.readOnly && (
                <button onClick={() => remove(d.key)} style={{ ...btnStyle, color: themeColor.red, borderColor: themeColor.red }}>
                  remove
                </button>
              )}
            </div>

            {!d.readOnly && (
              <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <Field label="job kind">
                  <select value={d.jobKind} onChange={(e) => patch(d.key, { jobKind: e.target.value })} style={inputStyle}>
                    {JOB_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Field>
                <Field label="schedule">
                  <select value={d.scheduleKind} onChange={(e) => patch(d.key, { scheduleKind: e.target.value })} style={inputStyle}>
                    {SCHEDULE_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Field>
                <div style={{ flex: '1 1 260px' }}>
                  <Field label={d.scheduleKind === 'cron' ? 'cron expression' : d.scheduleKind === 'once' ? 'instant' : 'seconds'} hint={expressionHint(d.scheduleKind)}>
                    <input
                      value={d.scheduleExpr}
                      onChange={(e) => patch(d.key, { scheduleExpr: e.target.value })}
                      placeholder={expressionHint(d.scheduleKind)}
                      style={inputStyle}
                    />
                  </Field>
                </div>
                <Field label="timezone" hint="explicit — the worker resolves it">
                  <input
                    value={d.timezone}
                    onChange={(e) => patch(d.key, { timezone: e.target.value })}
                    list={`tz-${d.key}`}
                    style={{ ...inputStyle, width: 180 }}
                  />
                  <datalist id={`tz-${d.key}`}>
                    {TIMEZONE_HINTS.map((tz) => <option key={tz} value={tz} />)}
                  </datalist>
                </Field>
              </div>
            )}

            {!d.readOnly && (
              <p style={{ ...labelStyle, margin: 0 }}>{scheduleHint(d.scheduleKind)}</p>
            )}

            {!d.readOnly && fields.length > 0 && (
              <div style={{ display: 'flex', gap: space[12], flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {fields.map((f) =>
                  f.key === 'content' ? (
                    <div key={f.key} style={{ flex: '1 1 380px' }}>
                      <Field label={f.label} hint={`${payloadValue(d, f.key).length} / 1900 characters`}>
                        <textarea
                          value={payloadValue(d, f.key)}
                          onChange={(e) => patchPayload(d.key, f.key, e.target.value)}
                          rows={3}
                          style={{ ...inputStyle, resize: 'vertical' }}
                        />
                      </Field>
                    </div>
                  ) : (
                    <div key={f.key} style={{ flex: '0 1 240px' }}>
                      <Field label={f.label} hint="a Discord channel snowflake">
                        <input
                          value={payloadValue(d, f.key)}
                          onChange={(e) => patchPayload(d.key, f.key, e.target.value)}
                          style={inputStyle}
                        />
                      </Field>
                    </div>
                  ),
                )}
              </div>
            )}

            <p style={{ ...labelStyle, margin: 0 }}>{reportLine(d)}</p>
          </div>
        );
      })}
    </div>
  );
}
