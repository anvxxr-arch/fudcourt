import fs from 'node:fs';
const recs = JSON.parse(fs.readFileSync('/tmp/binance_recs.json', 'utf8'));
const by = (k) => { const m = {}; for (const r of recs) m[r[k]] = (m[r[k]] || 0) + 1; return m; };
console.log('By Akun:', JSON.stringify(by('Akun'), null, 1));
console.log('\nBy Koin:', JSON.stringify(by('Koin'), null, 1));
console.log('\nAkun x Operasi:');
const m = {};
for (const r of recs) { const k = r.Akun + ' || ' + r.Operasi; m[k] = (m[k] || 0) + 1; }
for (const k of Object.keys(m).sort()) console.log(' ', k, m[k]);

// running balance per account+coin
const D = (s) => Number(s);
const bal = {};
for (const r of recs) {
  const k = r.Akun + ' | ' + r.Koin;
  bal[k] = (bal[k] || 0) + D(r.Ubah || 0);
}
console.log('\n=== NET CHANGE per Akun|Koin (6-15 Sep 2026) ===');
for (const k of Object.keys(bal).sort()) console.log(' ', k, bal[k].toFixed(8));

console.log('\n=== NON-ZERO events, chronological (with row#) ===');
const nz = recs.filter(r => Math.abs(D(r.Ubah||0)) > 1e-9);
console.log('non-zero rows:', nz.length, 'of', recs.length);
for (const r of recs) {
  const v = D(r.Ubah || 0);
  if (Math.abs(v) > 1e-9 && !/Funding Fee|^Fee$/.test(r.Operasi))
    console.log(`${r.__row} | ${r.Waktu} | ${r.Akun} | ${r.Operasi} | ${r.Koin} | ${v} | ${r.Catatan}`);
}