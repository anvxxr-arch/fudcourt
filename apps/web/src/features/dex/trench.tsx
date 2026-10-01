'use client';

import { useState, useEffect, useCallback } from 'react';
import { C } from '@/styles/shared';

type Profile = {
  address: string;
  chain: string;
  icon: string;
  header: string;
  description: string;
  links: any[];
  url: string;
};

export default function TrenchPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/dex?type=profiles&limit=50', { cache: 'no-store' });
      if (!res.ok) throw new Error('API error');
      const json = await res.json();
      setProfiles(json.data || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ color: C.accent, margin: 0 }}>New Listings — DEX Trench</h3>
        <button onClick={load} style={{ background: C.card, color: C.white, border: `1px solid ${C.border}`, padding: '6px 14px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {error && <p style={{ color: C.red, fontSize: 12 }}>{error}</p>}

      {loading ? (
        <p style={{ color: C.dim, fontSize: 12 }}>Loading new tokens...</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
          {profiles.map((p, i) => (
            <div
              key={p.address + i}
              style={{
                background: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: 8,
                overflow: 'hidden',
                cursor: 'pointer',
              }}
              onClick={() => window.open(p.url, '_blank')}
            >
              {p.header && (
                <div style={{
                  height: 60,
                  backgroundImage: `url(${p.header})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }} />
              )}
              <div style={{ padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  {p.icon && (
                    <img src={p.icon} alt="" style={{ width: 24, height: 24, borderRadius: '50%' }} />
                  )}
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 12, color: C.white }}>
                      {p.address.slice(0, 6)}...{p.address.slice(-4)}
                    </div>
                    <div style={{ fontSize: 10, color: C.dim }}>{p.chain}</div>
                  </div>
                </div>
                {p.description && (
                  <p style={{ fontSize: 10, color: C.dim, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {p.description.replace(/<[^>]*>/g, '').slice(0, 120)}
                  </p>
                )}
                <div style={{ marginTop: 6, display: 'flex', gap: 4 }}>
                  {p.links?.slice(0, 3).map((l: any, j: number) => (
                    <span key={j} style={{ fontSize: 9, color: C.accent, background: 'rgba(61,220,151,0.1)', padding: '2px 6px', borderRadius: 4 }}>
                      {l.label || l.type}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {profiles.length === 0 && !loading && (
            <p style={{ color: C.dim, fontSize: 12 }}>No new listings found</p>
          )}
        </div>
      )}
    </div>
  );
}
