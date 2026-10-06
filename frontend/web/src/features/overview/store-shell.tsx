'use client';

import { useState, useEffect, useCallback } from 'react';
import { Wallet, Asset, buildWalletMap, getAlias, getColor, groupSum } from '@/lib/format';
import { color, fontFamily, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
import { Banner } from '@/ui/banner';
import { Loading } from '@/ui/feedback';
import { viewPath } from '@/lib/view-routes';
import dynamic from 'next/dynamic';
import { loadOverviewBundle, saveWallet, type OverviewCoin, type OverviewReconRow, type OverviewTransaction } from './client';
const DashboardPage = dynamic(() => import('@/features/overview/dashboard'), { ssr: false });
const PortfolioPage = dynamic(() => import('@/features/overview/portfolio'), { ssr: false });
const WalletPage = dynamic(() => import('@/features/overview/wallets'), { ssr: false });
const TransactionPage = dynamic(() => import('@/features/overview/transactions'), { ssr: false });
const ReconciliationPage = dynamic(() => import('@/features/overview/reconciliation'), { ssr: false });
const SignalsPage = dynamic(() => import('@/features/signals/ui'), { ssr: false });
const ScoreboardPage = dynamic(() => import('@/features/scoreboard/ui'), { ssr: false });
const MarketHub = dynamic(() => import('@/features/market/hub'), { ssr: false });
const NewsPage = dynamic(() => import('@/features/news/ui'), { ssr: false });

type DbData = {
  assets: Asset[];
  coins: OverviewCoin[];
  coinTotal: number;
  wallets: Wallet[];
  transactions: OverviewTransaction[];
  reconRows: OverviewReconRow[];
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
      const { allData, wallets, coinsData, reconData } = await loadOverviewBundle();

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
    <div style={{ background: color.bgBase, padding: space[20], fontFamily: fontFamily.mono, minHeight: '100vh' }}>
      <Banner>Error: {error}</Banner>
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
    // Market is the market hub, keyed by asset class (/market/crypto,
    // /market/forex, /market/commodity, /market/stock, /market/trench). It
    // replaces the standalone /ticker and /markets surfaces, and it absorbed
    // the /tracker, /llama, /dex and /trench boards as tabs (crypto: Prices,
    // DeFi TVL; trench: Pairs, Trench). Those four standalone routes are gone —
    // next.config.js redirects them into the hub so old links still resolve.
    { key: 'market', label: 'Market' },
    { key: 'signals', label: 'Signals' },
    { key: 'scoreboard', label: 'Scoreboard' },
    { key: 'news', label: 'News' },
  ];
  // Team shell shows treasury tabs first, then the shared market boards.
  // Public/member shells show boards only — never wallet addresses,
  // transaction rows, or reconciliation rows.
  const tabs = isTeam ? [...TEAM_TABS, ...BOARD_TABS] : BOARD_TABS;
  // Per-board benefit headlines for the public shells. The team shell keeps
  // the FUDCOURT wordmark (treasury context, not a marketing surface).
  // All market-* sub-routes share the market headline.
  const BOARD_HEADERS: Record<string, { title: string; sub: string }> = {
    market: {
      title: 'Every market on one board — cross-checked before it prints',
      sub: 'CEX instruments cross-checked across venues, on-chain pairs gated by parity — dashes, never zeros.',
    },
    signals: {
      title: 'Screening output, not tips — every read parity-checked',
      sub: 'Read-only screening over a 168h window; dual-source parity or it does not publish.',
    },
    scoreboard: {
      title: 'Ranked by realized fills — no paper claims',
      sub: 'Tracked traders and wallets ranked on verified fills; vanity stats rejected.',
    },
    news: {
      title: 'News that survived gating — no fabricated items',
      sub: 'Aggregated feeds, decoy-rejected and freshness-bounded.',
    },
  };
  const boardKey = page.startsWith('market') ? 'market' : page;
  const boardHeader = !isTeam ? BOARD_HEADERS[boardKey] : undefined;

  return (
    <main style={{ background: color.bgBase, minHeight: '100vh', color: color.labelPrimary, padding: space[20], fontFamily: fontFamily.mono }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h1 style={{ margin: 0, color: color.blue, letterSpacing: letterSpacing.wider }}>{boardHeader ? boardHeader.title : 'FUDCOURT'}</h1>
          <p style={{ margin: `${space[4]}px 0 0`, color: color.labelSecondary, fontSize: fontSize[12] }}>
            {boardHeader ? boardHeader.sub : 'Community · Terminal · Management'}
            {/* Treasury fetch state (period / sync / spinner) only exists on a
                team shell — a public board never requests it, so showing it
                there would advertise a sync that does not happen. */}
            {isTeam && (
              <>
                {db?.period ? ` · period ${db.period}` : ''} · sync {lastSync || '...'}
                {loading && ' ⟳'}
              </>
            )}
            {!isTeam && ' · public boards — live data, no treasury sync'}
          </p>
        </div>
        {isTeam && (
          <div style={{ display: 'flex', gap: space[8], alignItems: 'center' }}>
            {/* Executor is its own multi-route area (PRD §81), not a board tab. */}
            <a
              href={viewPath('executor')}
              style={{ background: color.bgSecondary, color: color.blue, border: `1px solid ${color.separator}`, padding: `${space[8]}px ${space[16]}px`, borderRadius: radius[8], fontWeight: fontWeight.bold, cursor: 'pointer', textDecoration: 'none' }}>
              EXECUTOR
            </a>
            <button onClick={load} style={{ background: color.blue, color: color.labelOnAccent, border: 'none', padding: `${space[8]}px ${space[16]}px`, borderRadius: radius[8], fontWeight: fontWeight.bold, cursor: 'pointer' }}>
              SYNC
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: space[8], margin: `${space[16]}px 0`, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <a
            key={t.key}
            href={viewPath(t.key)}
            onClick={(e) => { e.preventDefault(); setPage(t.key); }}
            style={{
              background: page === t.key ? color.blue : color.bgSecondary,
              color: page === t.key ? color.labelOnAccent : color.labelPrimary,
              padding: `${space[8]}px ${space[16]}px`, border: `1px solid ${color.separator}`,
              borderRadius: radius[8], cursor: 'pointer', fontSize: fontSize[12],
              textDecoration: 'none',
            }}>
            {t.label}
          </a>
        ))}
      </div>

      {isTeam && loading && !db && <Loading label="Syncing treasury…" />}
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
          await saveWallet(w);
          load();
        }} />
      )}
      {page === 'transactions' && isTeam && (
        <TransactionPage transactions={db?.transactions || []} refreshTx={refreshTx} load={load} />
      )}
      {page === 'reconciliation' && isTeam && db?.reconRows && db?.reconWallets && (
        <ReconciliationPage rows={db.reconRows} wallets={db.reconWallets} />
      )}
      {page === 'market' && <MarketHub />}
      {page === 'market-crypto' && <MarketHub section="crypto" />}
      {page === 'market-forex' && <MarketHub section="forex" />}
      {page === 'market-commodity' && <MarketHub section="commodity" />}
      {page === 'market-stock' && <MarketHub section="stock" />}
      {page === 'market-trench' && <MarketHub section="trench" />}
      {page === 'signals' && <SignalsPage />}
      {page === 'scoreboard' && <ScoreboardPage />}
      {page === 'news' && <NewsPage />}

      <div style={{ marginTop: space[32], color: color.labelSecondary, fontSize: fontSize[11], borderTop: `1px solid ${color.separator}`, paddingTop: space[8] }}>
        {isTeam ? 'Fox · FUDCOURT OS · auto-refresh 30s · data: Postgres + TimescaleDB · live RPC' : 'Fox · FUDCOURT OS · public boards · data served live from origin APIs · no treasury sync'}
      </div>
    </main>
  );
}
