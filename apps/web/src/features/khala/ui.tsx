'use client';
import { useState, useCallback, useEffect, type CSSProperties } from 'react';
import { C } from '@/styles/shared';
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
    background: active ? C.accent : C.card,
    color: active ? '#04140f' : C.white,
    border: `1px solid ${C.border}`,
    padding: '5px 12px',
    borderRadius: 6,
    fontSize: 11,
    cursor: 'pointer',
    fontWeight: active ? 700 : 400,
  });
  const errorBanner = (text: string, tag: string) => (
    <p style={{ color: C.red, fontSize: 12, fontWeight: 700, background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.35)', padding: '8px 10px', borderRadius: 6, marginBottom: 8 }}>
      ⚠ khala {tag} error: {text} — no data faked
    </p>
  );
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h3 style={{ color: C.white, fontSize: 15, fontWeight: 800, margin: 0 }}>Research reports</h3>
        <button onClick={() => setMode('latest')} style={btn(mode === 'latest')}>Latest</button>
        <button onClick={() => setMode('reports')} style={btn(mode === 'reports')}>Archive</button>
        {mode === 'latest' && (
          <>
            <span style={{ color: C.dim, fontSize: 10 }}>showing</span>
            {[5, 10, 25, 50].map((n) => (
              <button key={n} onClick={() => setLimit(n)} style={{ ...btn(limit === n), padding: '3px 9px' }}>{n}</button>
            ))}
          </>
        )}
        <button onClick={() => { setOpenSlug(null); load(mode, limit); }} style={btn(false)}>↻ Refresh</button>
        <span style={{ color: C.dim, fontSize: 10 }}>
          {list ? `${countLabel(list)} · kind=${list.kind} · cache ${list.cache}` : ''}
        </span>
      </div>
      <p style={{ color: C.dim, fontSize: 10, margin: '0 0 6px' }}>
        read-only relay of khala.io research · same-origin proxy /api/khala · an em-dash means the field is absent
        upstream, never zero · the list source publishes no dates, so the date column is `{DASH}` unless the row came
        from Latest (the mode that fetches each report page to resolve one)
      </p>
      {list?.slice && (
        <p style={{ color: C.dim, fontSize: 10, margin: '0 0 8px', borderLeft: `2px solid ${C.border}`, paddingLeft: 8 }}>
          slice: {list.slice}
        </p>
      )}
      {(list?.missingSlugs?.length ?? 0) > 0 && (
        <p style={{ color: '#fbbf24', fontSize: 10, fontWeight: 700, margin: '0 0 8px' }}>
          ⚠ partial list: the homepage parse missed {list.missingSlugs!.length} slug
          {list.missingSlugs!.length === 1 ? '' : 's'} the sitemap enumerated — {list.missingSlugs!.join(', ')}
        </p>
      )}
      {error && errorBanner(error, 'reports')}
      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>loading khala reports…</p>
      ) : error ? (
        <p style={{ color: C.dim, fontSize: 12 }}>report list withheld — the request above failed.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: C.dim, textAlign: 'left' }}>
              <th style={{ padding: '5px 8px', width: 36 }}>#</th>
              <th style={{ padding: '5px 8px' }}>report</th>
              <th style={{ padding: '5px 8px', width: 110 }}>published</th>
              <th style={{ padding: '5px 8px', width: 74 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: C.dim, padding: 12 }}>
                  upstream returned no reports — genuinely empty, nothing faked.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.slug} style={{ borderTop: `1px solid ${C.border}` }}>
                <td style={{ padding: '7px 8px', color: C.dim }}>{r.position}</td>
                <td style={{ padding: '7px 8px' }}>
                  <div style={{ color: C.white, fontWeight: 700 }}>{r.title || r.slug}</div>
                  {r.summary
                    ? <div style={{ color: C.dim, fontSize: 10, marginTop: 2, lineHeight: 1.4 }}>{r.summary}</div>
                    : <div style={{ color: C.dim, fontSize: 10, marginTop: 2 }}>summary: {DASH}</div>}
                  <a href={r.url} target="_blank" rel="noopener noreferrer"
                    style={{ color: C.accent, fontSize: 9, textDecoration: 'none' }}>{r.url}</a>
                </td>
                <td style={{ padding: '7px 8px', color: r.publishedISO ? C.white : C.dim }}>
                  {r.published || DASH}
                  {r.publishedISO && (
                    <div style={{ color: C.dim, fontSize: 9 }}>{r.publishedISO}</div>
                  )}
                  {!r.publishedISO && (
                    <div style={{ color: C.dim, fontSize: 9 }}>{mode === 'reports' ? 'not in list source' : 'unresolved'}</div>
                  )}
                </td>
                <td style={{ padding: '7px 8px' }}>
                  <button onClick={() => openReport(r.slug)} style={btn(openSlug === r.slug)}>read</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {openSlug && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h4 style={{ color: C.accent, fontSize: 13, margin: 0 }}>Report reader</h4>
            <span style={{ color: C.dim, fontSize: 10 }}>key={openSlug}</span>
            <button onClick={() => { setOpenSlug(null); setReport(null); setReportError(''); }} style={btn(false)}>close</button>
          </div>
          {reportLoading && <p style={{ color: C.dim, fontSize: 12 }}>loading report…</p>}
          {reportError && errorBanner(reportError, 'report')}
          {report && (
            <>
              <h3 style={{ color: C.white, fontSize: 15, margin: '10px 0 4px' }}>{report.title}</h3>
              <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>
                {report.published || DASH} · {report.publishedISO || DASH}
                {report.metaTitle && report.metaTitle !== report.title ? ` · meta: ${report.metaTitle}` : ''}
              </div>
              <div style={{ fontSize: 11, marginBottom: 6 }}>
                {report.authors && report.authors.length > 0 ? (
                  <>by {report.authors.map((a, i) => (
                    <span key={`${a.name}-${i}`}>
                      {i > 0 ? ', ' : ''}
                      {a.url
                        ? <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>{a.name}</a>
                        : a.name}
                    </span>
                  ))}</>
                ) : (
                  <span style={{ color: C.dim }}>by {DASH}</span>
                )}
                {' · '}
                <a href={report.url} target="_blank" rel="noopener noreferrer" style={{ color: C.accent }}>khala.io source</a>
              </div>
              {reportEnvelope?.slice && (
                <p style={{ color: C.dim, fontSize: 10, margin: '0 0 8px', borderLeft: `2px solid ${C.border}`, paddingLeft: 8 }}>
                  slice: {reportEnvelope.slice}
                </p>
              )}
              {report.sections.length > 0 && (
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 10px', marginBottom: 10 }}>
                  <div style={{ color: C.dim, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                    contents ({report.sections.length})
                  </div>
                  {report.sections.map((s) => (
                    <div key={`${s.id}-${s.level}`} style={{ fontSize: 11, marginLeft: (s.level - 2) * 10 }}>
                      <a href={`#kh-${s.id}`} style={{ color: C.white, textDecoration: 'none' }}>
                        <span style={{ color: C.dim }}>h{s.level}</span> {s.title}
                      </a>
                    </div>
                  ))}
                </div>
              )}
              {/* Structured blocks in document order — React elements, never HTML. */}
              <div style={{ maxWidth: 760 }}>
                {report.body.map((b: KhBlock, i: number) => {
                  const id = b.id ? `kh-${b.id}` : undefined;
                  if (b.type === 'h2') return <h2 key={i} id={id} style={{ color: C.accent, fontSize: 14, margin: '16px 0 6px' }}>{b.text}</h2>;
                  if (b.type === 'h3') return <h3 key={i} id={id} style={{ color: C.white, fontSize: 12.5, margin: '13px 0 5px' }}>{b.text}</h3>;
                  if (b.type === 'h4') return <h4 key={i} id={id} style={{ color: C.white, fontSize: 11.5, margin: '11px 0 4px' }}>{b.text}</h4>;
                  if (b.type === 'li') return (
                    <div key={i} style={{ color: C.white, fontSize: 11.5, lineHeight: 1.6, paddingLeft: 14, margin: '2px 0' }}>
                      • {b.text}
                    </div>
                  );
                  return <p key={i} style={{ color: C.white, fontSize: 11.5, lineHeight: 1.6, margin: '6px 0' }}>{b.text}</p>;
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
