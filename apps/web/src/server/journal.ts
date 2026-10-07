/**
 * journal.ts — a double-entry journal DERIVED from the transaction ledger
 * (DR-047).
 *
 * WHY DERIVED, NOT WRITTEN. The `journal` table exists (and the `ledger`
 * table with it) but has no writer: DR-036 established both are dead, frozen at
 * the 2026-09-15 import, and DR-037 makes posted entries immutable and forbids
 * any portfolio view from writing financial truth to make itself agree. So the
 * journal is a *read* — computed on demand from the canonical `transactions`
 * rows — never a second, writable copy that could drift from them. This is the
 * same posture as the treasury time series (DR-045) and the P&L board (DR-046).
 *
 * THE HARD PART, AND HOW IT IS HANDLED. `transactions` is a list of ONE-SIDED
 * events: a signed `amount_usd` with an `IN`/`OUT` direction, not a pair of
 * legs. To make a balanced entry we must supply the counter-account by rule:
 *
 *   - fees (`Trading Fee`, `Funding Fee`, `Transaction Fee`) -> `5000 Fees & funding`
 *   - `Realized P&L`                                          -> `4000 Trading P&L`
 *   - external flows (`Deposit`, `Withdrawal`, `Subscription`,
 *     `Spend`)                                               -> `3000 External flows`
 *   - everything else (buy, swap, transfer, earn, …)          -> `1900 Internal clearing`
 *
 * The asset side is chosen from the `chain`: fiat -> `1010 Cash / bank`,
 * an exchange -> `1100 Trading margin`, an on-chain wallet -> `1000 Crypto
 * assets`. The sign rule is uniform: a positive `amount_usd` debits the asset
 * and credits the counter; a negative one credits the asset and debits the
 * counter. Every entry is therefore a balanced pair, and the trial balance sums
 * to zero by construction — but it is *computed*, not assumed.
 *
 * `1900` and `3000` are SYNTHETIC counter-accounts, defined here rather than in
 * the `accounts` table: they are the two accounts a single-sided ledger cannot
 * name for itself (the other side of an internal move; the outside world). The
 * clearing account's net balance is the honest signal of how much internal
 * movement is unmatched — a zero is the healthy case, and a non-zero balance is
 * shown, never hidden.
 *
 * NEVER-FAKE. A transaction with no `amount_usd` produces an entry with
 * `amount: null`, marked `unpriced`, and is excluded from every total: an
 * unpriced row is a gap, not a zero, and a journal that books it as `0` would
 * balance by lying.
 */
import 'server-only';
import { query, type Row } from './db';

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const round2 = (v: number): number => Math.round(v * 100) / 100;
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// The chart of accounts (the `accounts` table, plus the two synthetic counters)
// ---------------------------------------------------------------------------

export type AccountType = 'Asset' | 'Liability' | 'Revenue' | 'Expense' | 'Equity';

export type Account = {
  code: string;
  name: string;
  type: AccountType;
  statement: 'Balance sheet' | 'Income statement';
  /** The side a positive balance sits on. */
  normal: 'debit' | 'credit';
  /** True for a counter-account this derivation defines, absent from `accounts`. */
  synthetic?: boolean;
};

export const ACCOUNTS: readonly Account[] = [
  { code: '1000', name: 'Crypto assets', type: 'Asset', statement: 'Balance sheet', normal: 'debit' },
  { code: '1010', name: 'Cash / bank', type: 'Asset', statement: 'Balance sheet', normal: 'debit' },
  { code: '1100', name: 'Trading margin', type: 'Asset', statement: 'Balance sheet', normal: 'debit' },
  { code: '1900', name: 'Internal clearing', type: 'Asset', statement: 'Balance sheet', normal: 'debit', synthetic: true },
  { code: '2100', name: 'Liabilities', type: 'Liability', statement: 'Balance sheet', normal: 'credit' },
  { code: '3000', name: 'External flows', type: 'Equity', statement: 'Balance sheet', normal: 'credit', synthetic: true },
  { code: '4000', name: 'Trading P&L', type: 'Revenue', statement: 'Income statement', normal: 'credit' },
  { code: '5000', name: 'Fees & funding', type: 'Expense', statement: 'Income statement', normal: 'debit' },
];

const BY_CODE = new Map(ACCOUNTS.map((a) => [a.code, a]));
export const account = (code: string): Account => BY_CODE.get(code) ?? { code, name: code, type: 'Asset', statement: 'Balance sheet', normal: 'debit' };

const EXCHANGE_CHAINS = new Set(['Binance', 'Hyperliquid']);
const FIAT_CHAINS = new Set(['Finance']);
const FEE_EVENTS = new Set(['Trading Fee', 'Funding Fee', 'Transaction Fee']);
const EXTERNAL_EVENTS = new Set(['Deposit', 'Withdrawal', 'Subscription', 'Spend']);

/** The asset account an event's `chain` belongs to. */
export function assetAccount(chain: string): string {
  if (FIAT_CHAINS.has(chain)) return '1010';
  if (EXCHANGE_CHAINS.has(chain)) return '1100';
  return '1000';
}

export type PairKind = 'fee' | 'pnl' | 'external' | 'internal';

/** The counter-account for an event, and which family it belongs to. */
export function counterAccount(event: string): { code: string; kind: PairKind } {
  if (FEE_EVENTS.has(event)) return { code: '5000', kind: 'fee' };
  if (event === 'Realized P&L') return { code: '4000', kind: 'pnl' };
  if (EXTERNAL_EVENTS.has(event)) return { code: '3000', kind: 'external' };
  return { code: '1900', kind: 'internal' };
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export type JournalEntry = {
  /** The source transaction id. */
  txId: number;
  date: string;
  /** `J-00011`-style code, matching the table's convention. */
  code: string;
  memo: string;
  debitAccount: string;
  creditAccount: string;
  /** `null` when the source transaction carried no amount (unpriced). */
  amount: number | null;
  chain: string;
  asset: string | null;
  event: string;
  direction: string | null;
  kind: PairKind;
};

const memoOf = (t: { event: string; asset: string | null; chain: string }): string =>
  `${t.event}${t.asset ? ` · ${t.asset}` : ''} · ${t.chain}`;

/**
 * Every transaction as a balanced entry, newest first. `limit` caps the read
 * for the board; the totals are always computed over the whole ledger.
 */
export async function journalEntries(limit?: number): Promise<JournalEntry[]> {
  const sql =
    `SELECT id, date, chain, asset, event, direction, amount_usd::float8 AS amount_usd
     FROM transactions
     ORDER BY date DESC, id DESC` + (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = (await query(sql)) as Row[];
  return rows.map(toEntry);
}

function toEntry(r: Row): JournalEntry {
  const chain = String(r.chain);
  const asset = r.asset === null || r.asset === undefined ? null : String(r.asset);
  const event = String(r.event);
  const direction = r.direction === null || r.direction === undefined ? null : String(r.direction);
  const amt = num(r.amount_usd);
  const a = assetAccount(chain);
  const { code: c, kind } = counterAccount(event);
  // A positive amount debits the asset side; a negative one credits it. An
  // unpriced row (no amount) still gets an entry, with both sides and a null
  // amount, so the reader sees it — but it never enters a total.
  const debit = amt !== null && amt < 0 ? c : a;
  const credit = amt !== null && amt < 0 ? a : c;
  return {
    txId: Number(r.id),
    date: String(r.date),
    code: `J-${String(Number(r.id)).padStart(5, '0')}`,
    memo: memoOf({ event, asset, chain }),
    debitAccount: debit,
    creditAccount: credit,
    amount: amt === null ? null : round2(Math.abs(amt)),
    chain,
    asset,
    event,
    direction,
    kind,
  };
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export type TrialRow = {
  code: string;
  name: string;
  type: AccountType;
  statement: string;
  synthetic: boolean;
  debit: number;
  credit: number;
  /** `debit - credit`, signed. */
  net: number;
  /** The balance on the account's normal side (always >= 0 for a clean book). */
  balance: number;
};

export type TrialBalance = {
  rows: TrialRow[];
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
  /** `totalDebit - totalCredit`; zero when balanced. */
  diff: number;
  entryCount: number;
  /** Entries excluded from the totals because the source had no amount. */
  unpriced: number;
};

export async function trialBalance(): Promise<TrialBalance> {
  const entries = await journalEntries();
  const debit = new Map<string, number>();
  const credit = new Map<string, number>();
  let unpriced = 0;
  for (const e of entries) {
    if (e.amount === null) {
      unpriced += 1;
      continue;
    }
    debit.set(e.debitAccount, (debit.get(e.debitAccount) ?? 0) + e.amount);
    credit.set(e.creditAccount, (credit.get(e.creditAccount) ?? 0) + e.amount);
  }

  const codes = new Set<string>([...ACCOUNTS.map((a) => a.code), ...debit.keys(), ...credit.keys()]);
  const rows: TrialRow[] = [];
  for (const code of codes) {
    const acc = account(code);
    const d = round2(debit.get(code) ?? 0);
    const c = round2(credit.get(code) ?? 0);
    const net = round2(d - c);
    rows.push({
      code,
      name: acc.name,
      type: acc.type,
      statement: acc.statement,
      synthetic: acc.synthetic === true,
      debit: d,
      credit: c,
      net,
      balance: acc.normal === 'debit' ? net : round2(-net),
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));

  const totalDebit = round2([...debit.values()].reduce((x, y) => x + y, 0));
  const totalCredit = round2([...credit.values()].reduce((x, y) => x + y, 0));
  const diff = round2(totalDebit - totalCredit);
  return {
    rows,
    totalDebit,
    totalCredit,
    balanced: Math.abs(diff) < EPS,
    diff,
    entryCount: entries.length - unpriced,
    unpriced,
  };
}

// ---------------------------------------------------------------------------
// Flows (a treasury-shaped cash-flow summary)
// ---------------------------------------------------------------------------

export type FlowBucket = {
  key: 'operating' | 'external' | 'internal';
  label: string;
  /** Net USD into the tracked system for this bucket. */
  netUsd: number;
  inflowUsd: number;
  outflowUsd: number;
  entries: number;
};

export type Flows = {
  buckets: FlowBucket[];
  /** Net of all buckets — the change the ledger implies. */
  netUsd: number;
  /** The `1900 Internal clearing` balance: unmatched internal movement. */
  internalUnmatchedUsd: number;
  feesUsd: number;
  realizedPnlUsd: number;
  entryCount: number;
  unpriced: number;
};

/**
 * Three buckets, by the same counter-account families the entries use:
 *
 *   - operating  fees + realized P&L — the cost and result of trading;
 *   - external   money in from, and out to, outside the tracked system;
 *   - internal   moves between the treasury's own accounts, which net to zero
 *                when every leg is present. A non-zero `internalUnmatchedUsd`
 *                is the size of the gap, reported rather than smoothed away.
 */
export async function flows(): Promise<Flows> {
  const entries = await journalEntries();
  const buckets: Record<FlowBucket['key'], FlowBucket> = {
    operating: { key: 'operating', label: 'Operating (trading P&L + fees)', netUsd: 0, inflowUsd: 0, outflowUsd: 0, entries: 0 },
    external: { key: 'external', label: 'External (in / out of the system)', netUsd: 0, inflowUsd: 0, outflowUsd: 0, entries: 0 },
    internal: { key: 'internal', label: 'Internal (between own accounts)', netUsd: 0, inflowUsd: 0, outflowUsd: 0, entries: 0 },
  };
  let feesUsd = 0;
  let realizedPnlUsd = 0;
  let unpriced = 0;

  for (const e of entries) {
    if (e.amount === null) {
      unpriced += 1;
      continue;
    }
    // The asset leg's direction IS the flow direction into the tracked system.
    const assetIsDebit = e.debitAccount === assetAccount(e.chain);
    const signed = assetIsDebit ? e.amount : -e.amount;
    const bucketKey: FlowBucket['key'] = e.kind === 'fee' || e.kind === 'pnl' ? 'operating' : e.kind === 'external' ? 'external' : 'internal';
    const b = buckets[bucketKey];
    b.netUsd += signed;
    b.entries += 1;
    if (signed >= 0) b.inflowUsd += signed;
    else b.outflowUsd += -signed;
    if (e.kind === 'fee') feesUsd += e.amount;
    if (e.kind === 'pnl') realizedPnlUsd += signed;
  }

  const list = [buckets.operating, buckets.external, buckets.internal].map((b) => ({
    ...b,
    netUsd: round2(b.netUsd),
    inflowUsd: round2(b.inflowUsd),
    outflowUsd: round2(b.outflowUsd),
  }));

  // The clearing account's balance, read from the trial balance so the two
  // views cannot disagree about the same number.
  const trial = await trialBalance();
  const clearing = trial.rows.find((r) => r.code === '1900');

  return {
    buckets: list,
    netUsd: round2(list.reduce((a, b) => a + b.netUsd, 0)),
    internalUnmatchedUsd: clearing ? clearing.balance : 0,
    feesUsd: round2(feesUsd),
    realizedPnlUsd: round2(realizedPnlUsd),
    entryCount: entries.length - unpriced,
    unpriced,
  };
}
