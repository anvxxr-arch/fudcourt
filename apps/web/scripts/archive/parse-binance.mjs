import fs from 'node:fs';
const p = '/tmp/binance_export/Binance-Riwayat-Transaksi-202609152349(UTC+7)-part1-of1.csv';
const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
// proper CSV parse
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') {}
      else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const table = parseCSV(raw).filter(r => r.length > 1);
const header = table[0];
console.log('HEADER:', JSON.stringify(header));
const recs = table.slice(1).map((r, i) => {
  const o = {};
  header.forEach((h, j) => o[h] = (r[j] ?? '').trim());
  o.__row = i + 2;
  return o;
});
console.log('records:', recs.length);
// distribution
const by = (k) => {
  const m = {};
  for (const r of recs) m[r[k]] = (m[r[k]] || 0) + 1;
  return m;
};
console.log('\nBy Operasi:', JSON.stringify(by('Operasi'), null, 1));
console.log('\nBy Account:', JSON.stringify(by('Account'), null, 1));
console.log('\nBy Coin:', JSON.stringify(by('Coin'), null, 1));
console.log('\nFirst 3 rows:'); recs.slice(0,3).forEach(r => console.log(JSON.stringify(r)));
fs.writeFileSync('/tmp/binance_recs.json', JSON.stringify(recs, null, 1));
console.log('\nsaved /tmp/binance_recs.json');