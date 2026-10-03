'use client';

import { useState, useEffect, useCallback } from 'react';
import { color, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { EmptyState, Loading } from '@/components/ui/feedback';
import { Toolbar } from '@/components/ui/toolbar';

type NewsItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  image: string;
  source: string;
};

export default function NewsPage() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/news?limit=30', { cache: 'no-store' });
      if (!res.ok) throw new Error('API error');
      const json = await res.json();
      setItems(json.items || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmtDate = (d: string) => {
    try { return new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return d; }
  };

  return (
    <div>
      <Toolbar actions={
        <button onClick={load} style={{ background: color.surface, color: color.text, border: `1px solid ${color.border}`, padding: `${space[6]}px ${space[14]}px`, borderRadius: radius[6], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      }>
        <h3 style={{ color: color.accent, margin: 0 }}>Crypto News</h3>
      </Toolbar>

      {error && <p style={{ color: color.negative, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <Loading label="Loading news..." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: space[10] }}>
          {items.map((item, i) => (
            <div
              key={i}
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius[8],
                overflow: 'hidden',
                cursor: 'pointer',
              }}
              onClick={() => window.open(item.link, '_blank')}
            >
              {item.image && (
                <div style={{
                  height: 100,
                  backgroundImage: `url(${item.image})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }} />
              )}
              <div style={{ padding: space[10] }}>
                <div style={{ fontSize: fontSize[10], color: color.accent, marginBottom: space[4] }}>{item.source} · {fmtDate(item.pubDate)}</div>
                <div style={{ fontWeight: fontWeight.bold, fontSize: fontSize[12], color: color.text, marginBottom: space[4], lineHeight: lineHeight.tight }}>
                  {item.title}
                </div>
                {item.description && (
                  <p style={{ fontSize: fontSize[10], color: color.textMuted, margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          ))}
          {items.length === 0 && !loading && (
            <EmptyState style={{ textAlign: 'left', padding: 0 }}>No news found</EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
