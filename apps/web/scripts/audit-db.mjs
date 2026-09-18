import { query } from '../lib/db.ts';
import fs from 'node:fs';

const TABLES = ['accounts','assets','venues','wallets','transactions','journal','ledger','trades'];
const dump = {};
for (const t of TABLES) {
  try {
    const info = await query(`PRAGMA table_info(${t})`);
    const rows = await query(`SELECT * FROM ${t}`);
    dump[t] = { columns: info.map(r => r.name), rows };
    console.log(`${t}: ${rows.length} rows | cols: ${info.map(r => r.name).join(',')}`);
  } catch (e) {
    console.log(`${t}: ERROR ${e.message}`);
  }
}
const master = await query("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name");
dump.schema = master;
fs.writeFileSync('/tmp/fud_dump.json', JSON.stringify(dump, null, 1));
console.log('\nschema:\n' + master.map(r => r.sql).join('\n\n'));