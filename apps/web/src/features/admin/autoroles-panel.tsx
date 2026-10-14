'use client';

import { useCallback, useEffect, useState } from 'react';
import { fontSize, fontWeight, radius, space, themeColor } from '@/styles/tokens';
import { fetchAutoroles, saveAutoroles } from './client';
import { describeSaveFailure } from './save-error';
import {
  APPLIES,
  DELAY_NOTE,
  DEFERRED_NOTE,
  KINDS,
  MAX_DELAY,
  MAX_RULES,
  ORDER_NOTE,
  blankRule,
  duplicateRoleIds,
  fromRules,
  missingRoleIds,
  previewRules,
  toRules,
  type AutoroleDraftRule,
} from './autoroles-draft';
import { delayLabel, selectAutoroles, type AutoroleRule } from './autorole-select';

// The autorole editor: which roles a joiner gets, and when.
//
// The panel's own contribution is the PREVIEW at the bottom, and it is the same argument the welcome
// panel makes: the decision these rules describe is not readable off the rows. Priority decides the
// order, a delay of zero collapses into "immediate", `appliesTo` drops whole rules depending on
// whether the joiner is a bot, and one of the three kinds never fires at all — so the panel states
// the buckets the bot will compute (`autorole-select.ts` mirrors it, and the tests replay the bot's
// own fixtures) instead of leaving the operator to simulate the join in their head.
//
// Everything the api refuses stays the api's to refuse: an empty role id, a duplicate, an
// out-of-range wait. The panel surfaces those early as notes — the same words, before the round trip
// — and still sends the request, because one authority for what a valid rule is beats two.

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: space[12],
  padding: space[16],
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  background: themeColor.bgElevated,
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
  padding: `${space[4]}px ${space[10]}px`,
  border: `1px solid ${themeColor.blue}`,
  borderRadius: radius[8],
  background: 'transparent',
  color: themeColor.blue,
  fontSize: fontSize[12],
  cursor: 'pointer',
};

const btnPrimary: React.CSSProperties = { ...btnStyle, background: themeColor.blue, color: themeColor.labelOnAccent };

const iconBtnStyle: React.CSSProperties = { ...btnStyle, padding: `${space[4]}px ${space[8]}px` };

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: space[12],
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  padding: space[12],
  border: `1px solid ${themeColor.separator}`,
  borderRadius: radius[8],
  background: themeColor.bgSecondary,
};

function caption(text: string, tone: 'primary' | 'tertiary' = 'tertiary'): React.CSSProperties {
  return { fontSize: fontSize[11], color: tone === 'primary' ? themeColor.labelPrimary : themeColor.labelTertiary };
}

function field(labelText: string, hint: string | undefined, control: React.ReactNode) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: space[4] }}>
      <span style={caption(labelText)}>{hint === undefined ? labelText : `${labelText} — ${hint}`}</span>
      {control}
    </label>
  );
}

export default function AutorolesPanel() {
  const [rules, setRules] = useState<AutoroleDraftRule[]>([]);
  const [isBot, setIsBot] = useState(false);
  const [readError, setReadError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setReadError(undefined);
    try {
      const view = await fetchAutoroles();
      setRules(fromRules(view.autoroles ?? []));
    } catch (err) {
      setReadError(describeSaveFailure(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function patchRule(key: string, patch: Partial<AutoroleDraftRule>) {
    setRules((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRule(key: string) {
    setRules((rs) => rs.filter((r) => r.key !== key));
  }

  function moveRule(key: string, delta: number) {
    setRules((rs) => {
      const at = rs.findIndex((r) => r.key === key);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= rs.length) return rs;
      const next = [...rs];
      const [moved] = next.splice(at, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setNote(undefined);
    try {
      const view = await saveAutoroles(toRules(rules));
      // Adopt what the api reports, for the same reason the welcome panel does: the ids are new
      // (the write deletes and re-inserts), and the order the api echoes back is the order it
      // persisted, which is the order the preview must keep sorting by.
      setRules(fromRules(view.autoroles ?? []));
      setNote('saved — the bot reads these rules on the next join.');
    } catch (err) {
      setNote(describeSaveFailure(err));
    } finally {
      setBusy(false);
    }
  }

  const dupes = duplicateRoleIds(rules);
  const missing = missingRoleIds(rules);
  const off = rules.filter((r) => !r.enabled).length;
  const selection = selectAutoroles(previewRules(rules), isBot);
  const granted = selection.immediate.length + selection.delayed.length + selection.deferred.length;

  return (
    <div style={containerStyle}>
      <div style={{ display: 'flex', gap: space[12], alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={caption('join roles — replaced as a set', 'primary')}>
          {rules.length} of {MAX_RULES} rules
        </span>
        <button type="button" style={btnPrimary} onClick={() => void save()} disabled={busy}>
          {busy ? 'saving…' : 'Save'}
        </button>
        <button
          type="button"
          style={iconBtnStyle}
          onClick={() => setRules((rs) => [...rs, blankRule()])}
          disabled={rules.length >= MAX_RULES}
        >
          add rule
        </button>
      </div>

      {readError !== undefined && <span style={{ ...caption(readError), color: themeColor.red }}>{readError}</span>}
      {note !== undefined && <span style={caption(note, 'primary')}>{note}</span>}
      <span style={caption(ORDER_NOTE)} />

      {rules.length === 0 && <span style={caption('no rules yet — a joiner gets nothing from here.')} />}

      {rules.map((r, index) => (
        <div key={r.key} style={rowStyle}>
          <label style={{ display: 'flex', alignItems: 'center', gap: space[4], ...caption('on') }}>
            <input type="checkbox" checked={r.enabled} onChange={(e) => patchRule(r.key, { enabled: e.target.checked })} />
            <span style={caption('enabled')} />
          </label>
          {field(
            'role id',
            'digits',
            <input
              style={{ ...inputStyle, width: 200 }}
              value={r.roleId}
              placeholder="e.g. 1234567890123456789"
              onChange={(e) => patchRule(r.key, { roleId: e.target.value })}
            />,
          )}
          {field(
            'when',
            KINDS.find((k) => k.value === r.kind)?.hint,
            <select style={inputStyle} value={r.kind} onChange={(e) => patchRule(r.key, { kind: e.target.value as AutoroleDraftRule['kind'] })}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>,
          )}
          {field(
            'wait (seconds)',
            r.kind === 'after_duration' ? '0 means now' : 'unused by this kind',
            <input
              style={{ ...inputStyle, width: 110 }}
              type="number"
              min={0}
              max={MAX_DELAY}
              value={r.delaySeconds}
              disabled={r.kind !== 'after_duration'}
              onChange={(e) => patchRule(r.key, { delaySeconds: Number(e.target.value) })}
            />,
          )}
          {field(
            'applies to',
            undefined,
            <select style={inputStyle} value={r.appliesTo} onChange={(e) => patchRule(r.key, { appliesTo: e.target.value as AutoroleDraftRule['appliesTo'] })}>
              {APPLIES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>,
          )}
          {field(
            'priority',
            'higher first',
            <input
              style={{ ...inputStyle, width: 90 }}
              type="number"
              value={r.priority}
              onChange={(e) => patchRule(r.key, { priority: Number(e.target.value) })}
            />,
          )}
          <div style={{ display: 'flex', gap: space[4], marginLeft: 'auto' }}>
            <button type="button" style={iconBtnStyle} onClick={() => moveRule(r.key, -1)} disabled={index === 0} aria-label="move up">
              ↑
            </button>
            <button type="button" style={iconBtnStyle} onClick={() => moveRule(r.key, 1)} disabled={index === rules.length - 1} aria-label="move down">
              ↓
            </button>
            <button type="button" style={iconBtnStyle} onClick={() => removeRule(r.key)} aria-label="remove rule">
              ✕
            </button>
          </div>
        </div>
      ))}

      {missing.length > 0 && (
        <span style={{ ...caption(`rule${missing.length > 1 ? 's' : ''} ${missing.map((i) => i + 1).join(', ')}: roleId must be a Discord id (digits only)`), color: themeColor.red }}>
          rule{missing.length > 1 ? 's' : ''} {missing.map((i) => i + 1).join(', ')}: roleId must be a Discord id (digits only)
        </span>
      )}
      {dupes.length > 0 && (
        <span style={{ ...caption(`duplicate roleId ${dupes.join(', ')} — the api refuses a role twice whatever the kind.`), color: themeColor.red }}>
          duplicate roleId {dupes.join(', ')} — the api refuses a role twice whatever the kind.
        </span>
      )}
      {rules.some((r) => r.kind === 'after_duration' && r.delaySeconds > 0) && <span style={caption(DELAY_NOTE)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: space[8], paddingTop: space[4], borderTop: `1px solid ${themeColor.separator}` }}>
        <div style={{ display: 'flex', gap: space[12], alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={caption('what a joiner gets', 'primary')} />
          <button type="button" style={iconBtnStyle} onClick={() => setIsBot((v) => !v)}>
            {isBot ? 'a bot joining' : 'a human joining'}
          </button>
          <span style={caption('toggle to see how “applies to” filters the set')} />
        </div>

        {granted === 0 ? (
          <span style={caption('no enabled rule applies to this joiner: they get nothing from here.')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: space[8] }}>
            <Bucket label="now" rules={selection.immediate.map((r) => r.roleId)} />
            <Bucket
              label="later"
              rules={selection.delayed.map(({ rule, delaySeconds }) => `${rule.roleId} ${delayLabel(delaySeconds)}`)}
            />
            <Bucket label="after verification" rules={selection.deferred.map((r) => r.roleId)} />
          </div>
        )}
        {selection.deferred.length > 0 && <span style={{ ...caption(DEFERRED_NOTE), color: themeColor.orange }}>{DEFERRED_NOTE}</span>}
        {off > 0 && <span style={caption(`${off} rule${off > 1 ? 's are' : ' is'} switched off and grants nothing.`)} />}
      </div>
    </div>
  );
}

function Bucket({ label, rules }: { label: string; rules: string[] }) {
  if (rules.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: space[8], alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={{ ...caption(label), color: themeColor.labelSecondary, minWidth: 130 }}>{label}</span>
      {rules.map((rule) => (
        <span
          key={rule}
          style={{
            padding: `${space[4]}px ${space[8]}px`,
            border: `1px solid ${themeColor.separator}`,
            borderRadius: radius[8],
            background: themeColor.bgSecondary,
            color: themeColor.labelPrimary,
            fontSize: fontSize[12],
            fontWeight: fontWeight.semibold,
          }}
        >
          {rule}
        </span>
      ))}
    </div>
  );
}
