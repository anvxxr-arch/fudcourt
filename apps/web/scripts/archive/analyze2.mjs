import fs from 'node:fs';
const recs = JSON.parse(fs.readFileSync('/tmp/binance_recs.json', 'utf8'));
const D = (s) => Number(s || 0);
const out = [];
const log = (s) => out.push(s);

log('=== ALL SPOT ROWS (21) ===');
for (const r of recs.filter(r => r.Akun === 'Spot'))
  log(`${r.__row} | ${r.Waktu} | ${r.Operasi} | ${r.Koin} | ${r.Ubah} | ${r.Catatan}`);

log('\n=== FUTURES: Transfer/Withdraw/Deposit rows ===');
for (const r of recs.filter(r => /Transfer|Withdraw|Deposit/.test(r.Operasi)))
  log(`${r.__row} | ${r.Waktu} | ${r.Akun} | ${r.Operasi} | ${r.Koin} | ${r.Ubah} | ${r.Catatan}`);

log('\n=== FUTURES: Realized PnL aggregated per day ===');
const days = {};
for (const r of recs.filter(r => r.Operasi === 'Realized Profit and Loss')) {
  const d = r.Waktu.slice(0, 10);
  days[d] = (days[d] || 0) + D(r.Ubah);
}
let cum = 0;
for (const d of Object.keys(days).sort()) { cum += days[d]; log(`${d} | pnl ${days[d].toFixed(4)} | cum ${cum.toFixed(4)}`); }
log(`TOTAL realized PnL: ${cum.toFixed(6)}`);

log('\n=== Fees & Funding by day ===');
const fd = {};
for (const r of recs.filter(r => /Fee|Funding/.test(r.Operasi))) {
  const d = r.Waktu.slice(0, 10);
  const k = d + ' ' + r.Operasi;
  fd[k] = (fd[k] || 0) + D(r.Ubah);
}
for (const k of Object.keys(fd).sort()) log(`${k} = ${fd[k].toFixed(6)}`);

log('\n=== Big realized PnL trades (|v| >= 1) ===');
for (const r of recs.filter(r => r.Operasi === 'Realized Profit and Loss' && Math.abs(D(r.Ubah)) >= 1))
  log(`${r.__row} | ${r.Waktu} | ${r.Ubah} | ${r.Catatan}`);

log('\n=== Running balance: USD-M Futures USDT ===');
let b = 0;
for (const r of recs.filter(r => r.Akun === 'USD-M Futures')) {
  b += D(r.Ubah);
  if (/Transfer|Withdraw|Deposit/.test(r.Operasi) || Math.abs(D(r.Ubah)) >= 1)
    log(`${r.Waktu} | ${r.Operasi} | ${r.Ubah} | run=${b.toFixed(6)}`);
}
log(`FINAL futures USDT = ${b.toFixed(6)}`);
log(`\nRec count: ${recs.length}`);

fs.writeFileSync('/tmp/binance_analysis.txt', out.join('\n'));
console.log(out.join('\n'));