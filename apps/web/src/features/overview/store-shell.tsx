'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Wallet, Asset, buildWalletMap, getAlias, getColor, groupSum } from '@/lib/format';
import { themeColor, fontFamily, fontSize, fontWeight, letterSpacing, radius, space } from '@/styles/tokens';
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
const TreasuryPage = dynamic(() => import('@/features/treasury/ui'), { ssr: false });
const LeaderboardPage = dynamic(() => import('@/features/treasury/leaderboard'), { ssr: false });
const PnlPage = dynamic(() => import('@/features/treasury/pnl'), { ssr: false });
const JournalPage = dynamic(() => import('@/features/treasury/journal'), { ssr: false });
const PlansPage = dynamic(() => import('@/features/plans/ui'), { ssr: false });
const SignalsPage = dynamic(() => import('@/features/signals/ui'), { ssr: false });
const ScoreboardPage = dynamic(() => import('@/features/scoreboard/ui'), { ssr: false });
const MarketHub = dynamic(() => import('@/features/market/hub'), { ssr: false });
const NewsPage = dynamic(() => import('@/features/news/ui'), { ssr: false });
const RiskFeedPage = dynamic(() => import('@/features/risk/ui'), { ssr: false });
const ProofPage = dynamic(() => import('@/features/proof/ui'), { ssr: false });
const DerivativesPage = dynamic(() => import('@/features/derivatives/ui'), { ssr: false });
const EtfPage = dynamic(() => import('@/features/etf/ui'), { ssr: false });
const GlobalPage = dynamic(() => import('@/features/global/ui'), { ssr: false });
const BreadthPage = dynamic(() => import('@/features/breadth/ui'), { ssr: false });
const WhalesPage = dynamic(() => import('@/features/whales/ui'), { ssr: false });
const ChainsPage = dynamic(() => import('@/features/chains/ui'), { ssr: false });
const SectorsPage = dynamic(() => import('@/features/sectors/ui'), { ssr: false });
const CoinsPage = dynamic(() => import('@/features/coins/ui'), { ssr: false });
const MediaPage = dynamic(() => import('@/features/media/ui'), { ssr: false });
const InsightsPage = dynamic(() => import('@/features/insights/ui'), { ssr: false });
const ScreenerPage = dynamic(() => import('@/features/screener/ui'), { ssr: false });
const FundingPage = dynamic(() => import('@/features/funding/ui'), { ssr: false });

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
  const railRef = useRef<HTMLDivElement>(null);

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

  // Keep the active board tab on screen. The rail is a single scrolling line at
  // every width, so at a phone width the tab you are ON can start off-screen and
  // the reader then cannot see where they are. `block: 'nearest'` keeps the PAGE
  // itself from scrolling vertically while centring the pill horizontally.
  useEffect(() => {
    railRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [page]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', viewPath(page));
    }
  }, [page]);

  if (error && !db) return (
    <div style={{ background: themeColor.bgBase, padding: space[20], fontFamily: fontFamily.mono, minHeight: '100vh' }}>
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
    { key: 'treasury', label: 'Time Machine' },
    { key: 'leaderboard', label: 'Leaderboard' },
    { key: 'pnl', label: 'P&L' },
    { key: 'journal', label: 'Journal' },
    { key: 'plans', label: 'Plans' },
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
    { key: 'risk', label: 'Risk feed' },
    { key: 'derivatives', label: 'Derivatives' },
    { key: 'etf', label: 'ETF flows' },
    { key: 'global', label: 'Global' },
    { key: 'breadth', label: 'Breadth' },
    { key: 'whales', label: 'Whales' },
    { key: 'chains', label: 'Chains' },
    { key: 'sectors', label: 'Sectors' },
    { key: 'coins', label: 'Coins' },
    { key: 'media', label: 'Media' },
    { key: 'insights', label: 'Insights' },
    { key: 'screener', label: 'Screener' },
    { key: 'funding', label: 'Funding' },
    { key: 'news', label: 'News' },
    { key: 'proof', label: 'Proof of treasury' },
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
    risk: {
      title: 'What the market prices, beside what is being reported',
      sub: 'Prediction-market mids, thin books marked wide; the headline join is lexical, never causal.',
    },
    proof: {
      title: 'The treasury, committed — aggregates public, holdings private',
      sub: 'A total, a per-chain split and a SHA-256 digest over the full snapshot; unpriced holdings are named, never counted as zero.',
    },
    derivatives: {
      title: 'The futures tape, read verbatim from the venues',
      sub: 'Open interest, funding extremes, per-venue liquidations and the long/short ratio — a missing venue is a dash, never a zero.',
    },
    etf: {
      title: 'Where the spot-ETF money actually went',
      sub: 'Daily creations and redemptions per issuer, a cumulative series and per-issuer totals; unlabelled upstream rows stay unlabelled.',
    },
    global: {
      title: 'The whole market in one read',
      sub: 'Market cap, dominance and segment volumes beside the venue ranking — every figure read verbatim, none estimated.',
    },
    breadth: {
      title: 'Where the market is widening',
      sub: 'Tokenized real-world assets, the launch calendar, sector rotation and the venue ranking.',
    },
    whales: {
      title: 'The largest open positions, and which way they lean',
      sub: 'Notional, leverage, entry and liquidation price per position; the board states how many of the upstream total it sees.',
    },
    chains: {
      title: 'Chains & ecosystems',
      sub: 'Every chain, and the projects built on it',
    },
    sectors: {
      title: 'Sector taxonomy',
      sub: 'Where the money is rotating, sector by sector',
    },
    coins: {
      title: 'Coin directory',
      sub: 'Every coin, with the new listings beside it',
    },
    media: {
      title: 'CryptoRank media',
      sub: 'The videos and headlines CryptoRank is carrying',
    },
    insights: {
      title: 'Quarterly & AI digest',
      sub: 'Quarterly returns, beside the CryptoRank market read',
    },
    screener: {
      title: 'Full price list',
      sub: 'Every coin CryptoRank tracks, priced',
    },
    funding: {
      title: 'Per-symbol funding rates',
      sub: 'Funding across every venue CoinAnk tracks',
    },
  };
  const boardKey = page.startsWith('market') ? 'market' : page;
  const boardHeader = !isTeam ? BOARD_HEADERS[boardKey] : undefined;

  return (
    <main style={{ background: themeColor.bgBase, minHeight: '100vh', color: themeColor.labelPrimary, padding: space[20], fontFamily: fontFamily.mono }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: space[8] }}>
        <div>
          <h1 style={{ margin: 0, color: themeColor.blue, letterSpacing: letterSpacing.wider }}>{boardHeader ? boardHeader.title : 'FUDCOURT'}</h1>
          <p style={{ margin: `${space[4]}px 0 0`, color: themeColor.labelSecondary, fontSize: fontSize[12] }}>
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
              style={{ background: themeColor.bgSecondary, color: themeColor.blue, border: `1px solid ${themeColor.separator}`, padding: `${space[8]}px ${space[16]}px`, borderRadius: radius[8], fontWeight: fontWeight.bold, cursor: 'pointer', textDecoration: 'none' }}>
              EXECUTOR
            </a>
            <button onClick={load} style={{ background: themeColor.blue, color: themeColor.labelOnAccent, border: 'none', padding: `${space[8]}px ${space[16]}px`, borderRadius: radius[8], fontWeight: fontWeight.bold, cursor: 'pointer' }}>
              SYNC
            </button>
          </div>
        )}
      </div>

      {/*
        Mobile-first tab rail: ONE scrolling line, never a wrapped block.

        With `flexWrap: 'wrap'` the 28 board tabs measured 9 rows / 388px tall at
        390px and 12 rows / 520px at 320px — over half the phone viewport spent on
        navigation before a single figure rendered — and they never fit at ANY
        width (2657px of pills against 1880px even at 1920px, so desktop wrapped
        into 2-3 ragged rows too). `nowrap` + `overflowX: auto` puts them on one
        line at every width; each pill is `flexShrink: 0` so a nowrap row cannot
        squish the labels, and the active pill is scrolled into view because at a
        phone width it starts off-screen.
      */}
      <div
        ref={railRef}
        style={{ display: 'flex', gap: space[8], margin: `${space[16]}px 0`, flexWrap: 'nowrap', overflowX: 'auto' }}
      >
        {tabs.map(t => (
          <a
            key={t.key}
            href={viewPath(t.key)}
            onClick={(e) => { e.preventDefault(); setPage(t.key); }}
            data-active={page === t.key ? 'true' : undefined}
            style={{
              background: page === t.key ? themeColor.blue : themeColor.bgSecondary,
              color: page === t.key ? themeColor.labelOnAccent : themeColor.labelPrimary,
              padding: `${space[8]}px ${space[16]}px`, border: `1px solid ${themeColor.separator}`,
              borderRadius: radius[8], cursor: 'pointer', fontSize: fontSize[12],
              textDecoration: 'none', flexShrink: 0, whiteSpace: 'nowrap',
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
      {page === 'treasury' && isTeam && <TreasuryPage />}
      {page === 'leaderboard' && isTeam && <LeaderboardPage />}
      {page === 'pnl' && isTeam && <PnlPage />}
      {page === 'journal' && isTeam && <JournalPage />}
      {page === 'plans' && isTeam && <PlansPage />}
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
      {page === 'risk' && <RiskFeedPage />}
      {page === 'derivatives' && <DerivativesPage />}
      {page === 'etf' && <EtfPage />}
      {page === 'global' && <GlobalPage />}
      {page === 'breadth' && <BreadthPage />}
      {page === 'whales' && <WhalesPage />}
      {page === 'chains' && <ChainsPage />}
      {page === 'sectors' && <SectorsPage />}
      {page === 'coins' && <CoinsPage />}
      {page === 'media' && <MediaPage />}
      {page === 'insights' && <InsightsPage />}
      {page === 'screener' && <ScreenerPage />}
      {page === 'funding' && <FundingPage />}
      {page === 'news' && <NewsPage />}
      {page === 'proof' && <ProofPage />}

      {/* Footer status line — dot-separated facts, not a sentence. Sans still reads better
          than mono at 11px, where mono renders as terminal noise; every figure above it
          keeps mono, so the stack still means "a value" where it matters. */}
      <div style={{ marginTop: space[32], color: themeColor.labelSecondary, fontFamily: fontFamily.sans, fontSize: fontSize[11], borderTop: `1px solid ${themeColor.separator}`, paddingTop: space[8] }}>
        {isTeam ? 'Fox · FUDCOURT OS · auto-refresh 30s · data: Postgres + TimescaleDB · live RPC' : 'Fox · FUDCOURT OS · public boards · data served live from origin APIs · no treasury sync'}
      </div>
    </main>
  );
}
