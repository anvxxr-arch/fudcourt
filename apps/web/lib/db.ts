import { createClient } from '@libsql/client';

const client = createClient({
  url: 'libsql://fud-balance-anvxxr.aws-ap-northeast-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

export async function query(sql: string, args: any[] = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}

export async function execute(sql: string, args: any[] = []) {
  return client.execute({ sql, args });
}

export async function getAll() {
  const [accounts, transactions, journal, ledger, assets, wallets, trades, netWorthRows] = await Promise.all([
    query('SELECT * FROM accounts ORDER BY code'),
    query('SELECT * FROM transactions ORDER BY date DESC'),
    query('SELECT * FROM journal ORDER BY date DESC'),
    query('SELECT * FROM ledger ORDER BY account_code'),
    query('SELECT * FROM assets ORDER BY value_usd DESC'),
    query('SELECT * FROM wallets ORDER BY label'),
    query('SELECT * FROM trades ORDER BY date DESC LIMIT 20'),
    query('SELECT SUM(value_usd) as total FROM assets'),
  ]);
  return {
    accounts, transactions, journal, ledger, assets, wallets, trades,
    net_worth: (netWorthRows[0] as any)?.total ?? 0,
    period: '9 Sep 2026 – sekarang',
    liabilities: 0,
    pnl: 0,
    cashflow: -850,
  };
}

export { client };
