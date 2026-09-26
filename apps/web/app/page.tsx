'use client';

import { useState, useEffect, useCallback } from 'react';
import { C, Wallet, Asset, buildWalletMap, getAlias, getColor, groupSum } from '../lib/ui/shared';
import DashboardPage from './components/DashboardPage';
import PortfolioPage from './components/PortfolioPage';
import WalletPage from './components/WalletPage';
import TransactionPage from './components/TransactionPage';
import ReconciliationPage from './components/ReconciliationPage';
import CoinPage from './components/CoinPage';
import TrenchPage from './components/TrenchPage';
import SignalsPage from './components/SignalsPage';
import ScoreboardPage from './components/ScoreboardPage';
import TrackerPage from './components/TrackerPage';
import NewsPage from './components/NewsPage';

type DbData = {
  assets: Asset[];
  coins: { asset: string; total_usd: number; total_qty: number; chains: number; wallets: number }[];
  coinTotal: number;
  wallets: Wallet[];
  transactions: { id: number; date: string; chain: string; asset: string; event: string; amount_usd: number; direction: string; memo: string | null; wallet_to: string | null; hash: string | null; url: string | null; source: string; venue_id: string | null; trade_id: string | null }[];
  reconRows: { wallet: string; asset: string; current: number; in_sum: number; out_sum: number; expected: number; diff: number }[];
  reconWallets: Wallet[];
  period?: string;
  net_worth?: number;
};

export default function Home({ initialPage = 'dashboard' }: { initialPage?: string }) {
  const [db, setDb] = useState<DbData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState('');
  const [txRefresh, setTxRefresh] = useState(0);
  const [page, setPage] = useState(initialPage);

  const refreshTx = () => setTxRefresh(r => r + 1);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [allRes, wRes, coinsRes, reconRes] = await Promise.all([
        fetch('/api/all', { cache: 'no-store' }),
        fetch('/api/wallets', { cache: 'no-store' }),
        fetch('/api/coins', { cache: 'no-store' }),
        fetch('/api/reconcile', { cache: 'no-store' }),
      ]);
      if (!allRes.ok) throw new Error('api/all HTTP ' + allRes.status);

      const allData = await allRes.json();
      const wallets: Wallet[] = wRes.ok ? await wRes.json() : [];
      const coinsData = coinsRes.ok ? await coinsRes.json() : { coins: [], total: 0 };
      const reconData = reconRes.ok ? await reconRes.json() : { rows: [], wallets: [] };

      setDb({
        assets: allData.assets || [],
        coins: coinsData.coins || [],
        coinTotal: coinsData.total || 0,
        wallets,
        transactions: allData.transactions || [],
        period: allData.period,
        net_worth: allData.net_worth,
        reconRows: reconData.rows || [],
        reconWallets: reconData.wallets || [],
      });
      setLastSync(new Date().toLocaleTimeString('id-ID', { hour12: false }));
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const path = page === 'coin' ? '/coin' : page === 'trench' ? '/trench' : page === 'signals' ? '/signals' : page === 'scoreboard' ? '/scoreboard' : page === 'tracker' ? '/tracker' : page === 'news' ? '/news' : page === 'dashboard' ? '/balance' : `/${page}`;
      window.history.replaceState(null, '', path);
    }
  }, [page]);

  if (error && !db) return (
    <div style={{ background: C.bg, color: C.red, padding: 20, fontFamily: 'monospace', minHeight: '100vh' }}>
      Error: {error}
    </div>
  );

  const assets = db?.assets || [];
  const total = assets.reduce((s, a) => s + (Number(a.value_usd) || 0), 0);
  const wallets = db?.wallets || [];
  const balanceByWallet = groupSum(assets, a => a.wallet || 'Unassigned', a => a.value_usd);
  const walletByLabel = buildWalletMap(wallets);

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'portfolio', label: 'Portfolio' },
    { key: 'coin', label: 'Coin' },
    { key: 'wallets', label: `Wallets (${wallets.length})` },
    { key: 'transactions', label: `Transactions (${db?.transactions.length || 0})` },
    { key: 'reconciliation', label: 'Reconciliation' },
    { key: 'trench', label: 'Trench' },
    { key: 'signals', label: 'Signals' },
    { key: 'scoreboard', label: 'Scoreboard' },
    { key: 'tracker', label: 'Tracker' },
    { key: 'news', label: 'News' },
  ];

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.white, padding: 20, fontFamily: 'ui-monospace, monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, color: C.accent, letterSpacing: 2 }}>FUD BALANCE</h1>
          <p style={{ margin: '4px 0 0', color: C.dim, fontSize: 12 }}>
            Accounting OS · period {db?.period || '—'} · sync {lastSync || '...'}
            {loading && ' ⟳'}
          </p>
        </div>
        <button onClick={load} style={{ background: C.accent, color: '#04140f', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
          SYNC
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, margin: '18px 0', flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <a
            key={t.key}
            href={t.key === 'coin' ? '/coin' : t.key === 'trench' ? '/trench' : t.key === 'signals' ? '/signals' : t.key === 'scoreboard' ? '/scoreboard' : t.key === 'tracker' ? '/tracker' : t.key === 'news' ? '/news' : t.key === 'dashboard' ? '/balance' : `/${t.key}`}
            onClick={(e) => { e.preventDefault(); setPage(t.key); }}
            style={{
              background: page === t.key ? C.accent : C.card,
              color: page === t.key ? '#04140f' : C.white,
              padding: '8px 16px', border: `1px solid ${C.border}`,
              borderRadius: 8, cursor: 'pointer', fontSize: 12,
              textDecoration: 'none',
            }}>
            {t.label}
          </a>
        ))}
      </div>

      {page === 'dashboard' && (
        <DashboardPage assets={assets} total={total}
          getAlias={(l) => getAlias(l, walletByLabel)}
          getColor={(l) => getColor(l, walletByLabel)} />
      )}
      {page === 'portfolio' && (
        <PortfolioPage assets={assets}
          getAlias={(l) => getAlias(l, walletByLabel)} />
      )}
      {page === 'coin' && <CoinPage />}
      {page === 'wallets' && (
        <WalletPage wallets={wallets} balanceByWallet={balanceByWallet} onSave={async (w) => {
          await fetch('/api/wallets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(w) });
          load();
        }} />
      )}
      {page === 'transactions' && (
        <TransactionPage transactions={db?.transactions || []} refreshTx={refreshTx} load={load} />
      )}
      {page === 'reconciliation' && db?.reconRows && db?.reconWallets && (
        <ReconciliationPage rows={db.reconRows} wallets={db.reconWallets} />
      )}
      {page === 'trench' && <TrenchPage />}
      {page === 'signals' && <SignalsPage />}
      {page === 'scoreboard' && <ScoreboardPage />}
      {page === 'tracker' && <TrackerPage />}
      {page === 'news' && <NewsPage />}

      <div style={{ marginTop: 30, color: C.dim, fontSize: 11, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        Fox · FUD Balance OS · auto-refresh 30s · data: Turso libsql + live RPC
      </div>
    </div>
  );
}
