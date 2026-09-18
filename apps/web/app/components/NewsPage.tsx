'use client';

import { useState, useEffect, useCallback } from 'react';
import { C } from '../../lib/ui/shared';

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ color: C.accent, margin: 0 }}>Crypto News</h3>
        <button onClick={load} style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {error && <p style={{ color: C.red, fontSize: 12 }}>{error}</p>}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>Loading news...</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
          {items.map((item, i) => (
            <div
              key={i}
              style={{
                background: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
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
              <div style={{ padding: 10 }}>
                <div style={{ fontSize: 10, color: C.accent, marginBottom: 4 }}>{item.source} · {fmtDate(item.pubDate)}</div>
                <div style={{ fontWeight: 700, fontSize: 12, color: C.white, marginBottom: 4, lineHeight: 1.3 }}>
                  {item.title}
                </div>
                {item.description && (
                  <p style={{ fontSize: 10, color: C.dim, margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {item.description}
                  </p>
                )}
              </div>
            </div>
          ))}
          {items.length === 0 && !loading && (
            <p style={{ color: C.dim, fontSize: 12 }}>No news found</p>
          )}
        </div>
      )}
    </div>
  );
}
