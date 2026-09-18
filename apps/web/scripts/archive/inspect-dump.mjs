import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('/tmp/fud_dump.json','utf8'));
const show = (t, cols) => {
  console.log(`\n=== ${t.toUpperCase()} (${d[t].rows.length}) ===`);
  for (const r of d[t].rows) console.log(cols.map(c => r[c] ?? '').join(' | '));
};
show('venues', ['id','name','type']);
show('wallets', ['address','label','chain','monitored']);
show('assets', ['id','chain','asset','quantity','value_usd','wallet']);
show('accounts', ['code','name','type','statement']);
console.log('\n=== TRANSACTIONS (48) ===');
for (const r of d.transactions.rows)
  console.log([r.id, r.date, r.chain, r.asset, r.event, r.amount_usd, r.direction, r.wallet_to ?? '-', r.venue_id ?? '-', (r.hash||r.url||'').slice(0,20), (r.memo||'').slice(0,90)].join(' | '));
console.log('\n=== JOURNAL ===');
for (const r of d.journal.rows) console.log([r.id,r.date,r.entry_code,r.debit_account,r.credit_account,r.amount,r.status,r.memo].join(' | '));
console.log('\n=== LEDGER ===');
for (const r of d.ledger.rows) console.log([r.id,r.account_code,r.account_name,r.side,r.balance,r.currency].join(' | '));