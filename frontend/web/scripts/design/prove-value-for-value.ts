// Deterministic proof: every token the migration introduced equals the exact
// literal it replaced. A value-for-value migration cannot move a pixel.
//
// The `C.*` half of this proof ran while the legacy table still existed; `C` was DELETED at the
// cutover (DR-037), so the pre-migration side is now a FROZEN SNAPSHOT of the eight hex values
// `C` held — taken verbatim from the deleted table, which is what makes the comparison still
// meaningful rather than circular.
import { color, fontFamily, fontSize, fontWeight, letterSpacing, radius, space, zIndex } from '../../src/styles/tokens';
const C = {
  bg: '#07110f',
  card: '#0d1f1a',
  border: '#1c3a31',
  accent: '#3ddc97',
  green: '#3ddc97',
  dim: '#6b8f82',
  red: '#ff6b6b',
  white: '#e8fff7',
};

const fails: string[] = [];
const norm = (v: string) => {
  let s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s.slice(1).split('').map(c => c + c).join('');
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return s.replace(/\s+/g, '');
};
const eqColor = (l: string, a: string, b: string) => { if (norm(a) !== norm(b)) fails.push(`${l}: ${a} !== ${b}`); };
const eq = (l: string, a: unknown, b: unknown) => { if (a !== b) fails.push(`${l}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

// C.* -> color.* (the pre-migration source of truth)
eqColor('C.bg -> color.bg', C.bg, color.bg);
eqColor('C.red -> color.negative', C.red, color.negative);
eqColor('C.white -> color.text', C.white, color.text);
eqColor('C.accent -> color.accent', C.accent, color.accent);
eqColor('C.dim -> color.textMuted', C.dim, color.textMuted);
eqColor('C.card -> color.surface', C.card, color.surface);
eqColor('C.border -> color.border', C.border, color.border);
// raw literals replaced in primitives.tsx / store-shell.tsx
eqColor("'#04140f' -> color.textOnAccent", '#04140f', color.textOnAccent);
eqColor("'#fff' -> color.textInverse", '#fff', color.textInverse);
eqColor("'rgba(0,0,0,0.8)' -> color.overlay", 'rgba(0,0,0,0.8)', color.overlay);

// identity scales: key === value
for (const n of [0, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 30]) eq(`space[${n}]`, space[n as keyof typeof space], n);
for (const k of [0, 6, 8, 12, 14]) eq(`radius[${k}]`, radius[k as keyof typeof radius], k);
for (const n of [10, 11, 12, 14, 18, 20]) eq(`fontSize[${n}]`, fontSize[n as keyof typeof fontSize], n);
eq('fontWeight.bold', fontWeight.bold, 700);
eq('fontWeight.regular', fontWeight.regular, 400);
eq('letterSpacing.wider', letterSpacing.wider, 2);
eq('fontFamily.mono', fontFamily.mono, 'ui-monospace, monospace');
eq('zIndex.modal', zIndex.modal, 100);

if (fails.length) { console.log('VALUE_MISMATCH (' + fails.length + ')'); fails.forEach(f => console.log('   ' + f)); process.exit(1); }
console.log('VALUE_FOR_VALUE_OK — every migrated token equals the literal it replaced');
