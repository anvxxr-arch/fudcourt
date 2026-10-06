'use client';
import { Fragment } from 'react';
import { color, fontSize, fontWeight, letterSpacing, space } from '@/styles/tokens';
import { TBody, TD, TH, THead, TR, Table } from '@/ui/table';
import {
  DASH,
  fmtBp,
  fmtDate,
  fmtIndicator,
  fmtPolicyRate,
  toneOf,
  type IndicatorRow,
  type PolicyRateRow,
} from './client';
import { theadRowStyle, rowStyle } from './ui-shared';
/** A yield delta rendered in basis points, coloured by sign; absent -> `—`. */
export function Bp({ v }: { v: number | null | undefined }) {
  const t = toneOf(v);
  const c = t === 'negative' ? color.red : t === 'positive' ? color.green : color.labelTertiary;
  return <span style={{ color: c }}>{fmtBp(v)}</span>;
}
/** Region order the policy-rate table renders in — curated, not alphabetical. */
const POLICY_REGIONS = ['Americas', 'Europe', 'Asia-Pacific', 'Africa & Middle East'];
/** Shared style for a table's group-divider row. */
export const groupRowStyle: React.CSSProperties = {
  color: color.blue,
  fontWeight: fontWeight.bold,
  fontSize: fontSize[11],
  letterSpacing: letterSpacing.wider,
  paddingTop: space[8],
};
/**
 * Central-bank policy rates (BIS).
 *
 * Grouped by region so a 33-row table stays scannable, and every row carries the
 * observation date — a policy rate is a step function, so "3.875%" is meaningless
 * without knowing when it was last set. An area BIS did not return stays `—`.
 */
export function PolicyRateTable({ rows }: { rows: PolicyRateRow[] }) {
  const regions = POLICY_REGIONS.filter(r => rows.some(x => x.region === r));
  return (
    <div style={{ overflowX: 'auto', marginTop: space[12] }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH>Central bank</TH>
            <TH align="right">Policy rate</TH>
            <TH align="right">As of</TH>
          </TR>
        </THead>
        <TBody>
          {regions.map(region => (
            <Fragment key={region}>
              <TR>
                <TD colSpan={3} style={groupRowStyle}>{region.toUpperCase()}</TD>
              </TR>
              {rows.filter(r => r.region === region).map(r => (
                <TR key={r.area} style={rowStyle}>
                  <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                    <span title={r.note}>{r.bank}</span>
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>{fmtPolicyRate(r.rate)}</TD>
                  <TD align="right" style={{ color: color.labelTertiary }}>{r.date || DASH}</TD>
                </TR>
              ))}
            </Fragment>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
/**
 * US macro indicators (FRED).
 *
 * `value` arrives already transformed — a level, a year-over-year percent, or a
 * period change — together with the `unit` that names which, so this prints it
 * verbatim beside its observation date. Grouped by theme; nothing is recomputed.
 */
export function IndicatorTable({ rows }: { rows: IndicatorRow[] }) {
  const groups = Array.from(new Set(rows.map(r => r.group)));
  return (
    <div style={{ overflowX: 'auto', marginTop: space[12] }}>
      <Table style={{ fontSize: fontSize[11] }}>
        <THead>
          <TR style={theadRowStyle}>
            <TH>US indicator</TH>
            <TH align="right">Value</TH>
            <TH align="right">Observed</TH>
          </TR>
        </THead>
        <TBody>
          {groups.map(group => (
            <Fragment key={group}>
              <TR>
                <TD colSpan={3} style={groupRowStyle}>{group.toUpperCase()}</TD>
              </TR>
              {rows.filter(r => r.group === group).map(r => (
                <TR key={r.id} style={rowStyle}>
                  <TD style={{ color: color.labelPrimary, fontWeight: fontWeight.bold }}>
                    <span title={r.note}>{r.name}</span>
                  </TD>
                  <TD align="right" style={{ color: color.labelPrimary }}>{fmtIndicator(r.value, r.unit, r.decimals)}</TD>
                  <TD align="right" style={{ color: color.labelTertiary }}>{fmtDate(r.date)}</TD>
                </TR>
              ))}
            </Fragment>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
