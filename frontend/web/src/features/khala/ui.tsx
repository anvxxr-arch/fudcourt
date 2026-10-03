'use client';
import { useState, useCallback, useEffect, type CSSProperties } from 'react';
import { alpha, color, fontSize, fontWeight, letterSpacing, lineHeight, radius, space } from '@/styles/tokens';
import { Loading } from '@/components/ui/feedback';
import { Banner } from '@/components/ui/banner';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import {
  KH_DEFAULT_LIMIT,
  type KhBlock,
  type KhEnvelope,
  type KhError,
  type KhMode,
  type KhReport,
  type KhRow,
  khalaUrl,
} from './client';
/** The house em-dash: absent upstream is `—`, never `0` and never an invented value. */
const DASH = '—';
/** `count`/`upstreamTotal` label, honest about a window (the way pools are labelled). */
function countLabel(env: KhEnvelope | null): string {
  if (!env) return DASH;
  const total = env.upstreamTotal;
  if (total == null) return `${env.count} report${env.count === 1 ? '' : 's'}`;
  return `${env.count} of ${total} report${total === 1 ? '' : 's'}`;
}
/**
 * khala research board (khala.io) through the /api/khala read proxy.
 *
 * The family is research REPORTS, not news: khala.io is a Framer site whose 8
 * reports (11-URL sitemap.xml) are its only content — /news, /blog, /rss.xml and
 * /feed are real 404s, measured 2026-09-29. So the primary view is
 * `mode=latest&limit=10`, which resolves a real publication date per report and
 * reads like a feed, and `mode=reports` is the full archive list. Both labels
 * and the sidecar's own `slice` sentence (which carries the "no news surface
 * exists" disclosure verbatim) are rendered rather than paraphrased.
 *
 * Render safety: the report body arrives as a structured block array
 * (`{type,id?,text}`, inline emphasis already flattened to text upstream), so it
 * is drawn as React elements. `dangerouslySetInnerHTML` is never used and no
 * sanitizer is needed — third-party markup does not reach this component's DOM
 * by construction of the wire contract, not by a filter here.
 */
export default function KhalaPage() {
  const [mode, setMode] = useState<KhMode>('latest');
  const [limit, setLimit] = useState(KH_DEFAULT_LIMIT);
  const [rows, setRows] = useState<KhRow[]>([]);
  const [list, setList] = useState<KhEnvelope | null>(null);
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [report, setReport] = useState<KhReport | null>(null);
  const [reportEnvelope, setReportEnvelope] = useState<KhEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState('');
  const [reportError, setReportError] = useState('');
  // A non-2xx answer is the sidecar's own error body (400 param, 404 no such
  // report, 502 wall/drift). Surfacing its `error`/`detail` verbatim is the
  // point: a substituted message would hide which layer failed.
  const failText = async (res: Response): Promise<string> => {
    const body = (await res.json().catch(() => ({}))) as KhError;
    const detail = body.detail ? ` — ${body.detail}` : '';
    return `${body.error || `HTTP ${res.status}`}${detail} (status ${res.status})`;
  };
  const load = useCallback(async (m: KhMode, lim: number) => {
    setLoading(true);
    setError('');
    try {
      const url = m === 'latest' ? khalaUrl(m, { limit: lim }) : khalaUrl(m);
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(await failText(res));
      const env = (await res.json()) as KhEnvelope;
      // `kind` is the RESOLVED mode; `mode` is only the echo, so a sidecar that
      // answered a different shape than we asked for is caught here instead of
      // rendering a list we cannot trust.
      if (env.kind !== m) throw new Error(`sidecar answered kind=${String(env.kind)} for mode=${m}`);
      setRows(env.rows ?? []);
      setList(env);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
      setList(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(mode, limit); }, [load, mode, limit]);
  const openReport = useCallback(async (slug: string) => {
    setOpenSlug(slug);
    setReportLoading(true);
    setReportError('');
    setReport(null);
    try {
      const res = await fetch(khalaUrl('report', { key: slug }), { cache: 'no-store' });
      if (!res.ok) throw new Error(await failText(res));
      const env = (await res.json()) as KhEnvelope;
      if (!env.report) throw new Error('sidecar answered mode=report with no report payload');
      setReport(env.report);
      setReportEnvelope(env);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
      setReportEnvelope(null);
    } finally {
      setReportLoading(false);
    }
  }, []);
  const btn = (active: boolean): CSSProperties => ({
    background: active ? color.accent : color.surface,
    color: active ? color.textOnAccent : color.text,
    border: `1px solid ${color.border}`,
    padding: '5px 12px',
    borderRadius: radius[6],
    fontSize: fontSize[11],
    cursor: 'pointer',
    fontWeight: active ? fontWeight.bold : fontWeight.regular,
  });
  const errorBanner = (text: string, tag: string) => (
    <Banner variant="error" style={{ fontWeight: fontWeight.bold, marginBottom: space[8] }}>
      ⚠ khala {tag} error: {text} — no data faked
    </Banner>
  );
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: space[10], flexWrap: 'wrap', marginBottom: space[8] }}>
        <h3 style={{ color: color.text, fontSize: fontSize[16], fontWeight: fontWeight.heavy, margin: 0 }}>Research reports</h3>
        <button onClick={() => setMode('latest')} style={btn(mode === 'latest')}>Latest</button>
        <button onClick={() => setMode('reports')} style={btn(mode === 'reports')}>Archive</button>
        {mode === 'latest' && (
          <>
            <span style={{ color: color.textMuted, fontSize: fontSize[10] }}>showing</span>
            {[5, 10, 25, 50].map((n) => (
              <button key={n} onClick={() => setLimit(n)} style={{ ...btn(limit === n), padding: '3px 9px' }}>{n}</button>
            ))}
          </>
        )}
        <button onClick={() => { setOpenSlug(null); load(mode, limit); }} style={btn(false)}>↻ Refresh</button>
        <span style={{ color: color.textMuted, fontSize: fontSize[10] }}>
          {list ? `${countLabel(list)} · kind=${list.kind} · cache ${list.cache}` : ''}
        </span>
      </div>
      <p style={{ color: color.textMuted, fontSize: fontSize[10], margin: `0 0 ${space[6]}px` }}>
        read-only relay of khala.io research · same-origin proxy /api/khala · an em-dash means the field is absent
        upstream, never zero · the list source publishes no dates, so the date column is `{DASH}` unless the row came
        from Latest (the mode that fetches each report page to resolve one)
      </p>
      {list?.slice && (
        <p style={{ color: color.textMuted, fontSize: fontSize[10], margin: `0 0 ${space[8]}px`, borderLeft: `2px solid ${color.border}`, paddingLeft: space[8] }}>
          slice: {list.slice}
        </p>
      )}
      {(list?.missingSlugs?.length ?? 0) > 0 && (
        <p style={{ color: color.warn, fontSize: fontSize[10], fontWeight: fontWeight.bold, margin: `0 0 ${space[8]}px` }}>
          ⚠ partial list: the homepage parse missed {list.missingSlugs!.length} slug
          {list.missingSlugs!.length === 1 ? '' : 's'} the sitemap enumerated — {list.missingSlugs!.join(', ')}
        </p>
      )}
      {error && errorBanner(error, 'reports')}
      {loading ? (
        <Loading label="loading khala reports…" />
      ) : error ? (
        <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>report list withheld — the request above failed.</p>
      ) : (
        <Table style={{ fontSize: fontSize[12] }}>
          <THead>
            <TR style={{ borderBottom: 0 }}>
              <TH style={{ padding: `5px ${space[8]}px`, width: 36, fontWeight: fontWeight.bold }}>#</TH>
              <TH style={{ padding: `5px ${space[8]}px`, fontWeight: fontWeight.bold }}>report</TH>
              <TH style={{ padding: `5px ${space[8]}px`, width: 110, fontWeight: fontWeight.bold }}>published</TH>
              <TH style={{ padding: `5px ${space[8]}px`, width: 74, fontWeight: fontWeight.bold }} />
            </TR>
          </THead>
          <TBody>
            {rows.length === 0 && (
              <TR style={{ borderBottom: 0 }}>
                <TD colSpan={4} style={{ color: color.textMuted, padding: space[12] }}>
                  upstream returned no reports — genuinely empty, nothing faked.
                </TD>
              </TR>
            )}
            {rows.map((r) => (
              <TR key={r.slug} style={{ borderTop: `1px solid ${color.border}`, borderBottom: 0 }}>
                <TD style={{ padding: `7px ${space[8]}px`, color: color.textMuted }}>{r.position}</TD>
                <TD style={{ padding: `7px ${space[8]}px` }}>
                  <div style={{ color: color.text, fontWeight: fontWeight.bold }}>{r.title || r.slug}</div>
                  {r.summary
                    ? <div style={{ color: color.textMuted, fontSize: fontSize[10], marginTop: 2, lineHeight: lineHeight.snug }}>{r.summary}</div>
                    : <div style={{ color: color.textMuted, fontSize: fontSize[10], marginTop: 2 }}>summary: {DASH}</div>}
                  <a href={r.url} target="_blank" rel="noopener noreferrer"
                    style={{ color: color.accent, fontSize: fontSize[9], textDecoration: 'none' }}>{r.url}</a>
                </TD>
                <TD style={{ padding: `7px ${space[8]}px`, color: r.publishedISO ? color.text : color.textMuted }}>
                  {r.published || DASH}
                  {r.publishedISO && (
                    <div style={{ color: color.textMuted, fontSize: fontSize[9] }}>{r.publishedISO}</div>
                  )}
                  {!r.publishedISO && (
                    <div style={{ color: color.textMuted, fontSize: fontSize[9] }}>{mode === 'reports' ? 'not in list source' : 'unresolved'}</div>
                  )}
                </TD>
                <TD style={{ padding: `7px ${space[8]}px` }}>
                  <button onClick={() => openReport(r.slug)} style={btn(openSlug === r.slug)}>read</button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {openSlug && (
        <div style={{ marginTop: space[14], borderTop: `1px solid ${color.border}`, paddingTop: space[10] }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: space[10], flexWrap: 'wrap' }}>
            <h4 style={{ color: color.accent, fontSize: fontSize[13], margin: 0 }}>Report reader</h4>
            <span style={{ color: color.textMuted, fontSize: fontSize[10] }}>key={openSlug}</span>
            <button onClick={() => { setOpenSlug(null); setReport(null); setReportError(''); }} style={btn(false)}>close</button>
          </div>
          {reportLoading && <Loading label="loading report…" />}
          {reportError && errorBanner(reportError, 'report')}
          {report && (
            <>
              <h3 style={{ color: color.text, fontSize: fontSize[16], margin: '10px 0 4px' }}>{report.title}</h3>
              <div style={{ color: color.textMuted, fontSize: fontSize[10], marginBottom: space[4] }}>
                {report.published || DASH} · {report.publishedISO || DASH}
                {report.metaTitle && report.metaTitle !== report.title ? ` · meta: ${report.metaTitle}` : ''}
              </div>
              <div style={{ fontSize: fontSize[11], marginBottom: space[6] }}>
                {report.authors && report.authors.length > 0 ? (
                  <>by {report.authors.map((a, i) => (
                    <span key={`${a.name}-${i}`}>
                      {i > 0 ? ', ' : ''}
                      {a.url
                        ? <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: color.accent }}>{a.name}</a>
                        : a.name}
                    </span>
                  ))}</>
                ) : (
                  <span style={{ color: color.textMuted }}>by {DASH}</span>
                )}
                {' · '}
                <a href={report.url} target="_blank" rel="noopener noreferrer" style={{ color: color.accent }}>khala.io source</a>
              </div>
              {reportEnvelope?.slice && (
                <p style={{ color: color.textMuted, fontSize: fontSize[10], margin: `0 0 ${space[8]}px`, borderLeft: `2px solid ${color.border}`, paddingLeft: space[8] }}>
                  slice: {reportEnvelope.slice}
                </p>
              )}
              {report.sections.length > 0 && (
                <div style={{ background: color.surface, border: `1px solid ${color.border}`, borderRadius: radius[8], padding: `${space[8]}px ${space[10]}px`, marginBottom: space[10] }}>
                  <div style={{ color: color.textMuted, fontSize: fontSize[9], textTransform: 'uppercase', letterSpacing: letterSpacing.xs, marginBottom: space[4] }}>
                    contents ({report.sections.length})
                  </div>
                  {report.sections.map((s) => (
                    <div key={`${s.id}-${s.level}`} style={{ fontSize: fontSize[11], marginLeft: (s.level - 2) * 10 }}>
                      <a href={`#kh-${s.id}`} style={{ color: color.text, textDecoration: 'none' }}>
                        <span style={{ color: color.textMuted }}>h{s.level}</span> {s.title}
                      </a>
                    </div>
                  ))}
                </div>
              )}
              {/* Structured blocks in document order — React elements, never HTML. */}
              <div style={{ maxWidth: 760 }}>
                {report.body.map((b: KhBlock, i: number) => {
                  const id = b.id ? `kh-${b.id}` : undefined;
                  if (b.type === 'h2') return <h2 key={i} id={id} style={{ color: color.accent, fontSize: fontSize[14], margin: `${space[16]}px 0 ${space[6]}px` }}>{b.text}</h2>;
                  if (b.type === 'h3') return <h3 key={i} id={id} style={{ color: color.text, fontSize: fontSize[13], margin: '13px 0 5px' }}>{b.text}</h3>;
                  if (b.type === 'h4') return <h4 key={i} id={id} style={{ color: color.text, fontSize: fontSize[12], margin: '11px 0 4px' }}>{b.text}</h4>;
                  if (b.type === 'li') return (
                    <div key={i} style={{ color: color.text, fontSize: fontSize[12], lineHeight: lineHeight.normal, paddingLeft: space[14], margin: '2px 0' }}>
                      • {b.text}
                    </div>
                  );
                  return <p key={i} style={{ color: color.text, fontSize: fontSize[12], lineHeight: lineHeight.normal, margin: `${space[6]}px 0` }}>{b.text}</p>;
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
