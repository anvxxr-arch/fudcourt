'use client';

import { useState, useEffect, useCallback } from 'react';
import { alpha, color, fontSize, fontWeight, radius, space } from '@/styles/tokens';
import { imgSrc } from '@/lib/img';
import { fetchDexProfiles } from './client';

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
      const json = await fetchDexProfiles<{ data?: Profile[] }>(50);
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
        <h3 style={{ color: color.blue, margin: 0 }}>New Listings — DEX Trench</h3>
        <button onClick={load} style={{ background: color.bgSecondary, color: color.labelPrimary, border: `1px solid ${color.separator}`, padding: `${space[8]}px ${space[12]}px`, borderRadius: radius[8], fontSize: fontSize[11], cursor: 'pointer' }}>
          ↻ Refresh
        </button>
      </div>

      {error && <p style={{ color: color.red, fontSize: fontSize[12] }}>{error}</p>}

      {loading ? (
        <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>Loading new tokens...</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: space[8] }}>
          {profiles.map((p, i) => (
            <div
              key={p.address + i}
              style={{
                background: color.bgSecondary,
                border: `1px solid ${color.separator}`,
                borderRadius: radius[8],
                overflow: 'hidden',
              }}
            >
              {p.header && (
                <div style={{
                  height: 60,
                  backgroundImage: `url(${imgSrc(p.header)})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }} />
              )}
              <div style={{ padding: space[8] }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: space[8], marginBottom: space[4] }}>
                  {p.icon && (
                    <img src={imgSrc(p.icon)} alt="" width={24} height={24} loading="lazy" decoding="async" style={{ width: space[24], height: space[24], borderRadius: radius.circle }} />
                  )}
                  <div>
                    <div style={{ fontWeight: fontWeight.bold, fontSize: fontSize[12], color: color.labelPrimary }}>
                      {p.address.slice(0, 6)}...{p.address.slice(-4)}
                    </div>
                    <div style={{ fontSize: fontSize[11], color: color.labelTertiary }}>{p.chain}</div>
                  </div>
                </div>
                {p.description && (
                  <p style={{ fontSize: fontSize[11], color: color.labelTertiary, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {p.description.replace(/<[^>]*>/g, '').slice(0, 120)}
                  </p>
                )}
                <div style={{ marginTop: space[8], display: 'flex', gap: space[4] }}>
                  {p.links?.slice(0, 3).map((l: any, j: number) => (
                    <span key={j} style={{ fontSize: fontSize[11], color: color.blue, background: alpha(color.blue, 0.1), padding: '2px 6px', borderRadius: radius[8] }}>
                      {l.label || l.type}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))}
          {profiles.length === 0 && !loading && (
            <p style={{ color: color.labelTertiary, fontSize: fontSize[12] }}>No new listings found</p>
          )}
        </div>
      )}
    </div>
  );
}
