/** Direct proof that the treasury read path reads the single local store
 *  (Postgres+Timescale, DR-040): prints every wallet label+address so a PG-only
 *  edit is visible verbatim. Uses the same getAll() the /api/all route calls. */
import { getAll } from '@/platform/db/client';

const d = (await getAll()) as Record<string, unknown>;
const wallets = (d.wallets ?? []) as Record<string, unknown>[];
console.log('net_worth:', d.net_worth, '| wallets:', wallets.length, '| assets:', (d.assets as unknown[])?.length ?? 0, '| tx:', (d.transactions as unknown[])?.length ?? 0);
for (const w of wallets) console.log('  wallet', String(w.address).slice(0, 10), '=', w.label);
