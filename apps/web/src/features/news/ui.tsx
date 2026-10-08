'use client';

import { useState, useEffect, useCallback } from 'react';
import { themeColor, fontSize, fontWeight, lineHeight, radius, space } from '@/styles/tokens';
import { EmptyState, Loading } from '@/ui/feedback';
import { Toolbar } from '@/ui/toolbar';
import { imgSrc } from '@/lib/img';
import { fetchNews } from './client';

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
      const json = await fetchNews();
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
        <button onClick={load} style={{ background: themeColor.bgSecondary, color: themeColor.labelPrimary, border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      }>
        <h2 style={{ color: themeColor.blue, margin: 0, fontSize: fontSize[17] }}>Crypto News</h2>
      </Toolbar>

      {error && <p style={{ color: themeColor.red, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <Loading label="Loading news..." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: space[8] }}>
          {items.map((item, i) => (
            <div
              key={i}
              style={{
                background: themeColor.bgSecondary,
                border: `1px solid ${themeColor.separator}`,
                borderRadius: radius[8],
                overflow: 'hidden',
              }}
            >
              {item.image && (
                <div style={{
                  height: 100,
                  backgroundImage: `url(${imgSrc(item.image)})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }} />
              )}
              <div style={{ padding: space[8] }}>
                <div style={{ fontSize: fontSize[11], color: themeColor.blue, marginBottom: space[4] }}>{item.source} · {fmtDate(item.pubDate)}</div>
                <div style={{ fontWeight: fontWeight.bold, fontSize: fontSize[12], color: themeColor.labelPrimary, marginBottom: space[4], lineHeight: lineHeight.tight }}>
                  {item.title}
                </div>
                {item.description && (
                  <p style={{ fontSize: fontSize[11], color: themeColor.labelTertiary, margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
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
