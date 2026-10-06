'use client';
/**
 * ui-settings.tsx — ExecutorSettings (§88).
 * Split from ui-manage.tsx; re-exported through ./ui-manage and ./ui.
 */
import { useCallback, useEffect, useState } from 'react';
import { color, fontSize, fontWeight, space } from '@/styles/tokens';
import { Button, Card, Input, Select } from '@/ui/primitives';
import { Banner } from '@/ui/banner';
import { Field } from '@/ui/field';
import { DEFAULT_RISK_PROFILE, type RiskProfile } from '@/lib/executor';
import { errorMessage, getSettings, putSettings } from './client';
import { h3Style, noteStyle, pairStyle } from './ui-shared';
import { URGENCY_OPTIONS } from './ui-composer';


// ---------------------------------------------------------------------------
// ExecutorSettings — §88
// ---------------------------------------------------------------------------

export function ExecutorSettings() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_RISK_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const body = await getSettings();
      setProfile(body.profile);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setNumber = useCallback((key: keyof RiskProfile) => (text: string) => {
    const value = Number(text);
    if (text.trim() !== '' && Number.isFinite(value)) setProfile((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const body = await putSettings(profile);
      setProfile(body.profile);
      setNotice('risk profile saved — every new execution is validated against it (PRD §88)');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [profile]);

  return (
    <>
      <div style={{ display: 'flex', gap: space[8], alignItems: 'center', flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ ...h3Style, margin: 0 }}>RISK SETTINGS · §88</h3>
        <Button onClick={load} disabled={loading}>↻ Refresh</Button>
        <Button onClick={save} disabled={saving || loading} variant="primary">Save profile</Button>
        <span style={{ color: color.labelTertiary, fontSize: fontSize[11] }}>{loading ? 'loading…' : ''}</span>
      </div>
      {error !== '' && <Banner variant="error" style={{ margin: `0 0 ${space[8]}px`, whiteSpace: 'pre-wrap', fontWeight: fontWeight.bold }}>⚠ {error}</Banner>}
      {notice !== '' && <p style={{ color: color.blue, fontSize: fontSize[11], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>✓ {notice}</p>}

      <Card>
        <div style={{ ...pairStyle }}>
          <Field label="Default risk mode">
            <Select
              value={profile.defaultRiskMode}
              onChange={(defaultRiskMode) => setProfile((prev) => ({ ...prev, defaultRiskMode }))}
              options={[{ value: 'risk_percent', label: 'Risk % of basis' }, { value: 'risk_usd', label: 'Risk $' }]}
            />
          </Field>
          <Field label={profile.defaultRiskMode === 'risk_percent' ? 'Default risk (%)' : 'Default risk ($)'}>
            <Input
 value={String(profile.defaultRisk)} onChange={setNumber('defaultRisk')} type="number" />
          </Field>
          <Field label="Maximum risk / trade (%)">
            <Input
 value={String(profile.maxRiskPerTradePct)} onChange={setNumber('maxRiskPerTradePct')} type="number" />
          </Field>
          <Field label="Max total open risk (%)" hint="committed risk across all live executions, as a % of total exchange equity — a new opening that would exceed it is REFUSED, not resized">
            <Input
 value={String(profile.maxOpenRiskPct)} onChange={setNumber('maxOpenRiskPct')} type="number" />
          </Field>
          <Field label="Max daily loss (%)" hint="once today's realized P&L reaches -this, new openings are blocked; closing and reducing stay available">
            <Input
 value={String(profile.maxDailyLossPct)} onChange={setNumber('maxDailyLossPct')} type="number" />
          </Field>
          <Field label="Max leverage (x)">
            <Input
 value={String(profile.maxLeverage)} onChange={setNumber('maxLeverage')} type="number" />
          </Field>
          <Field label="Default margin mode">
            <Select
              value={profile.defaultMarginMode}
              onChange={(defaultMarginMode) => setProfile((prev) => ({ ...prev, defaultMarginMode }))}
              options={[{ value: 'isolated', label: 'Isolated' }, { value: 'cross', label: 'Cross' }]}
            />
          </Field>
          <Field label="Default execution urgency">
            <Select
              value={profile.defaultExecutionUrgency}
              onChange={(defaultExecutionUrgency) => setProfile((prev) => ({ ...prev, defaultExecutionUrgency }))}
              options={URGENCY_OPTIONS}
            />
          </Field>
        </div>
        <p style={noteStyle}>
          `maxRiskPerTradePct` and `maxLeverage` block a request that exceeds them at creation (PRD §79); the portfolio
          limits are stored for the later enforcement phase · per-account overrides are not available yet (PRD §88)
        </p>
      </Card>
    </>
  );
}
