'use client';

import { useState, useEffect, useCallback } from 'react';
import { C, Wallet, Asset, buildWalletMap, getAlias, getColor, groupSum } from '@/styles/shared';
import { MUT_HEADERS } from '@/platform/http/mut-client';
import { viewPath } from '@/platform/routing/view-routes';
import DashboardPage from '@/features/dashboard/ui';
import PortfolioPage from '@/features/portfolio/ui';
import WalletPage from '@/features/wallets/ui';
import TransactionPage from '@/features/transactions/ui';
import ReconciliationPage from '@/features/treasury/reconciliation';
import TrenchPage from '@/features/dex/trench';
import DexPage from '@/features/dex/ui';
import SignalsPage from '@/features/signals/ui';
import ScoreboardPage from '@/features/scoreboard/ui';
import ChainrankPage from '@/features/chainrank/ui';
import CryptorankPage from '@/features/cryptorank/ui';
import LlamaPage from '@/features/llama/ui';
import TrackerPage from '@/features/tracker/ui';
import TickerPage from '@/features/ticker/ui';
import NewsPage from '@/features/news/ui';
import KhalaPage from '@/features/khala/ui';

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

export type ShellInitialPage = string;

export default function StoreShell({ initialPage = 'ticker', isTeam = false }: { initialPage?: ShellInitialPage; isTeam?: boolean }) {
  const [db, setDb] = useState<DbData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastSync, setLastSync] = useState('');
  const [txRefresh, setTxRefresh] = useState(0);
  const [page, setPage] = useState(initialPage);

  const refreshTx = () => setTxRefresh(r => r + 1);

  const load = useCallback(async () => {
    // Public/member surface renders market boards only: those components fetch
    // their own public APIs. The treasury bundle (/api/all, /api/wallets,
    // /api/coins, /api/reconcile) is team-gated server-side, so only request
    // it when this shell instance is mounted under /team/**.
    if (!isTeam) {
      setLoading(false);
      return;
    }
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [isTeam]);

  useEffect(() => { load(); if (!isTeam) return; const t = setInterval(load, 30000); return () => clearInterval(t); }, [load, isTeam]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', viewPath(page));
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

  const TEAM_TABS = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'portfolio', label: 'Portfolio' },
    { key: 'wallets', label: `Wallets (${wallets.length})` },
    { key: 'transactions', label: `Transactions (${db?.transactions.length || 0})` },
    { key: 'reconciliation', label: 'Reconciliation' },
  ];
  const BOARD_TABS = [
    { key: 'trench', label: 'Trench' },
    { key: 'dex', label: 'Dex' },
    { key: 'signals', label: 'Signals' },
    { key: 'scoreboard', label: 'Scoreboard' },
    { key: 'chainrank', label: 'Chainrank' },
    { key: 'cryptorank', label: 'CryptoRank' },
    { key: 'llama', label: 'Llama' },
    { key: 'tracker', label: 'Tracker' },
    { key: 'ticker', label: 'Ticker' },
    { key: 'news', label: 'News' },
    { key: 'khala', label: 'Khala' },
  ];
  // Team shell shows treasury tabs first, then the shared market boards.
  // Public/member shells show boards only — never wallet addresses,
  // transaction rows, or reconciliation rows.
  const tabs = isTeam ? [...TEAM_TABS, ...BOARD_TABS] : BOARD_TABS;

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.white, padding: 20, fontFamily: 'ui-monospace, monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h1 style={{ margin: 0, color: C.accent, letterSpacing: 2 }}>FUDCOURT</h1>
          <p style={{ margin: '4px 0 0', color: C.dim, fontSize: 12 }}>
            Community · Terminal · Management
            {/* Treasury fetch state (period / sync / spinner) only exists on a
                team shell — a public board never requests it, so showing it
                there would advertise a sync that does not happen. */}
            {isTeam && (
              <>
                {db?.period ? ` · period ${db.period}` : ''} · sync {lastSync || '...'}
                {loading && ' ⟳'}
              </>
            )}
          </p>
        </div>
        {isTeam && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {/* Executor is its own multi-route area (PRD §81), not a board tab. */}
            <a
              href={viewPath('executor')}
              style={{ background: C.card, color: C.accent, border: `1px solid ${C.border}`, padding: '10px 18px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', textDecoration: 'none' }}>
              EXECUTOR
            </a>
            <button onClick={load} style={{ background: C.accent, color: '#04140f', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
              SYNC
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, margin: '18px 0', flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <a
            key={t.key}
            href={viewPath(t.key)}
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

      {page === 'dashboard' && isTeam && (
        <DashboardPage assets={assets} total={total}
          getAlias={(l) => getAlias(l, walletByLabel)}
          getColor={(l) => getColor(l, walletByLabel)} />
      )}
      {page === 'portfolio' && isTeam && (
        <PortfolioPage assets={assets}
          getAlias={(l) => getAlias(l, walletByLabel)} />
      )}
      {page === 'wallets' && isTeam && (
        <WalletPage wallets={wallets} balanceByWallet={balanceByWallet} onSave={async (w) => {
          await fetch('/api/wallets', { method: 'POST', headers: MUT_HEADERS, body: JSON.stringify(w) });
          load();
        }} />
      )}
      {page === 'transactions' && isTeam && (
        <TransactionPage transactions={db?.transactions || []} refreshTx={refreshTx} load={load} />
      )}
      {page === 'reconciliation' && isTeam && db?.reconRows && db?.reconWallets && (
        <ReconciliationPage rows={db.reconRows} wallets={db.reconWallets} />
      )}
      {page === 'trench' && <TrenchPage />}
      {page === 'dex' && <DexPage />}
      {page === 'signals' && <SignalsPage />}
      {page === 'scoreboard' && <ScoreboardPage />}
      {page === 'chainrank' && <ChainrankPage />}
      {page === 'cryptorank' && <CryptorankPage />}
      {page === 'llama' && <LlamaPage />}
      {page === 'tracker' && <TrackerPage />}
      {page === 'ticker' && <TickerPage />}
      {page === 'news' && <NewsPage />}
      {page === 'khala' && <KhalaPage />}

      <div style={{ marginTop: 30, color: C.dim, fontSize: 11, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
        Fox · FUDCOURT OS · auto-refresh 30s · data: Turso libsql + live RPC
      </div>
    </div>
  );
}
