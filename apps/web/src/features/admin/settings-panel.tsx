'use client';

import { useCallback, useEffect, useState } from 'react';
import { themeColor, fontSize, radius, space } from '@/styles/tokens';
import { fetchSettings, saveSettings, type AdminSettings, type DiscordConfig, type DiscordRole } from './client';

// FIELDS is the editable Discord wiring, in panel order.
const FIELDS: { key: keyof DiscordConfig; label: string; hint: string }[] = [
  { key: 'guildId', label: 'Guild ID', hint: 'the Discord server tiers are read from' },
  { key: 'roleAdmin', label: 'Admin role', hint: 'guild role that maps to the admin tier' },
  { key: 'roleTeam', label: 'Team role', hint: 'guild role that maps to the team tier' },
  { key: 'roleMagang', label: 'Magang role', hint: 'role granted to a brand-new signup' },
];

const EMPTY: DiscordConfig = { guildId: '', roleAdmin: '', roleTeam: '', roleMagang: '' };

const fieldStyle: React.CSSProperties = {
  background: themeColor.bgBase,
  color: themeColor.labelPrimary,
  border: `1px solid ${themeColor.labelTertiary}`,
  borderRadius: radius[8],
  padding: `${space[4]}px ${space[6]}px`,
  fontSize: fontSize[13],
  width: '100%',
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

// SettingsPanel is the admin form for the DB-backed Discord wiring: the guild
// id and the three role mappings, each a picker over the guild's live roles.
// Saving writes the `settings` table (never .env) so a change lands on the next
// request — no edit, no restart.
export default function SettingsPanel() {
  const [data, setData] = useState<AdminSettings | null>(null);
  const [form, setForm] = useState<DiscordConfig>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const body = await fetchSettings();
      setError(null);
      setData(body);
      setForm({ ...EMPTY, ...(body.config ?? {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
      setData(null);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const roles: DiscordRole[] = data?.roles ?? [];

  const save = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      await saveSettings(form);
      setNote('saved');
      await load();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }, [form, load]);

  const set = (k: keyof DiscordConfig) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  if (error) return <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>settings read failed: {error}</p>;
  if (!data) return <p style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[12], maxWidth: 640 }}>
      {!data.configured && (
        <p style={{ color: themeColor.red, fontSize: fontSize[12], margin: 0 }}>
          Settings store not wired (FUDCOURT_PG_URL unset) — showing env defaults, changes cannot be saved.
        </p>
      )}
      {FIELDS.map(({ key, label, hint }) => {
        const current = form[key];
        const known = roles.some((r) => r.id === current);
        return (
          <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
            <span style={{ color: themeColor.labelPrimary, fontSize: fontSize[13] }}>{label}</span>
            <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[11] }}>{hint}</span>
            <select value={current} onChange={set(key)} style={fieldStyle}>
              <option value="">— unset —</option>
              {!known && current !== '' && <option value={current}>{current} (current)</option>}
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}{r.managed ? ' · bot' : ''} ({r.id})
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <div style={{ display: 'flex', gap: space[12], alignItems: 'center' }}>
        <button onClick={save} disabled={busy || !data.configured} style={btnStyle}>
          {busy ? 'saving…' : 'save'}
        </button>
        <button onClick={load} disabled={busy} style={btnStyle}>reload</button>
        {note && <span style={{ color: themeColor.labelTertiary, fontSize: fontSize[12] }}>{note}</span>}
      </div>
    </div>
  );
}
