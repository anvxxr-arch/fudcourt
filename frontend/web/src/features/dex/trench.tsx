'use client';

import { useState, useEffect, useCallback } from 'react';
import { alpha, color, fontSize, fontWeight, radius, space } from '@/styles/tokens';

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: space[12] }}>
        <h3 style={{ color: color.accent, margin: 0 }}>New Listings — DEX Trench</h3>
        <button onClick={load} style={{ background: color.surface, color: color.text, border: `1px solid ${color.border}`, padding: `${space[6]}px ${space[14]}px`, borderRadius: radius[6], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {error && <p style={{ color: color.negative, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>Loading new tokens...</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: space[10] }}>
          {profiles.map((p, i) => (
            <div
              key={p.address + i}
              style={{
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius[8],
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
              <div style={{ padding: space[10] }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: space[8], marginBottom: space[4] }}>
                  {p.icon && (
                    <img src={p.icon} alt="" style={{ width: space[24], height: space[24], borderRadius: radius.circle }} />
                  )}
                  <div>
                    <div style={{ fontWeight: fontWeight.bold, fontSize: fontSize[12], color: color.text }}>
                      {p.address.slice(0, 6)}...{p.address.slice(-4)}
                    </div>
                    <div style={{ fontSize: fontSize[10], color: color.textMuted }}>{p.chain}</div>
                  </div>
                </div>
                {p.description && (
                  <p style={{ fontSize: fontSize[10], color: color.textMuted, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {p.description.replace(/<[^>]*>/g, '').slice(0, 120)}
                  </p>
                )}
                <div style={{ marginTop: space[6], display: 'flex', gap: space[4] }}>
                  {p.links?.slice(0, 3).map((l: any, j: number) => (
                    <span key={j} style={{ fontSize: fontSize[9], color: color.accent, background: alpha(color.accent, 0.1), padding: '2px 6px', borderRadius: radius[4] }}>
                      {l.label || l.type}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {profiles.length === 0 && !loading && (
            <p style={{ color: color.textMuted, fontSize: fontSize[12] }}>No new listings found</p>
          )}
        </div>
      )}
    </div>
  );
}
