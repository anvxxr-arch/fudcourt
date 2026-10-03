import { getPayload } from 'payload'
import sharp from 'sharp'
import config from '@/cms/payload.config'

/**
 * Seed: 2 categories + 3 published posts (hero image via sharp SVG->PNG).
 * Idempotent: slugs are upserted, rerunning never duplicates.
 * Run: cd frontend/web && bunx payload run src/cms/seed.ts   (merged app, DR-017)
 *
 * PITFALL (why this file is written top-level): `payload run` does
 * `await import(script)` then `process.exit(0)`. A floating `main()`
 * promise is killed between those two lines — silent no-op, exit 0.
 * Top-level await makes the import resolve only when the work is done,
 * and any throw propagates to the CLI as a loud exit 1.
 */

type LexNode = Record<string, unknown>
const text = (t: string): LexNode => ({ type: 'text', text: t, format: 0, version: 1 })
const para = (t: string): LexNode => ({
  type: 'paragraph', children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1,
})
const heading = (t: string, level = 2): LexNode => ({
  type: 'heading', children: [text(t)], direction: 'ltr', format: '', indent: 0, version: 1,
  tag: `h${level}`,
})
const doc = (blocks: LexNode[]): any => ({  // lexical node tree: payload's generated types are stricter than runtime
  root: { type: 'root', children: blocks, direction: 'ltr', format: '', indent: 0, version: 1 },
})

const POSTS = [
  {
    slug: 'how-a-board-is-gated',
    title: 'How a market board gets gated: three checks before any data ships',
    excerpt:
      'Parity with a second source is not proof of truth. Before a cryptorank panel ships in fudcourt, every data family passes a 3-gate detector — including a semantic ground truth a fabricator cannot guess.',
    readingTime: 6,
    tags: ['verification', 'data-integrity', 'reverse-engineering'],
    content: doc([
      para('Every market surface wired into fudcourt is reverse-engineered HTML — we run no API keys, so trust has to be earned by evidence, not by a vendor badge.'),
      heading('Gate 1 — the router must be honest'),
      para('Request a nonexistent slug. An honest upstream returns 404. If it answers 200 with a fabricated entity, the surface is a decoy and it is rejected on the spot — no exceptions, no "we will validate later".'),
      heading('Gate 2 — value parity against an independent feed'),
      para('Coin prices and aggregate figures are compared against coins.llama.fi and CoinGecko with measured tolerances (≤3% for quoted prices, wider only for high-churn aggregates, every bound anchored to a documented class — never widened to make a gate green).'),
      heading('Gate 3 — semantic ground truth'),
      para('The strongest gate asks a question only reality can answer: does this launchpool window match the exchange’s own announcement date? Does this prediction market line up with the official league schedule? Does this media entry echo the platform’s published title and channel? A payload generator cannot guess these without actually knowing the world.'),
      para('Surfaces that fail any gate are documented with their evidence and stay disabled as loud 503 refusals — an honest refusal beats a pretty empty table.'),
    ]),
  },
  {
    slug: 'the-decoy-that-passed-parity',
    title: 'The decoy that passed parity: a post-mortem of self-consistent lies',
    excerpt:
      'A payload can agree with itself, agree with a second source, and still be fabricated. The fudcourt funding/ICO routes did exactly that — here is what they served and how the class got rejected.',
    readingTime: 5,
    tags: ['post-mortem', 'decoys', 'reverse-engineering'],
    content: doc([
      para('Back-to-back parity looked clean on the funding rounds surface. The same route then fabricated coin names like "zenith-dao-labs" and "lunar-cash", priced BTC anywhere between 57k and 67k while the true price sat at 84.5k, and answered 200 for slugs that do not exist.'),
      heading('What made it convincing'),
      para('Self-consistency. Every number in the payload agreed with every other number in the payload. Even a two-source spot check can pass when the fabricated body is internally coherent and the check only samples a few fields.'),
      heading('Other members of the rejected class'),
      para('/exchanges/perpetuals/dex returned a payload byte-identical to /perpetuals — a filtered view that was never a view. /performance printed literal "N/A" in every ROI cell while looking like a rendered table. Average-ROI-by-sector never disclosed its constituents, so no falsification path existed at all.'),
      heading('The rule that came out of it'),
      para('Parity proves self-consistency, never truth. Every family needs a gate it cannot fake, and rejection is a first-class outcome: documented with evidence, wired as a loud 503, never silently dropped.'),
    ]),
  },
  {
    slug: 'never-fake-rules',
    title: 'Never fake: the integrity rules fudcourt sync runs on',
    excerpt:
      'Failed RPC calls never become zero, sparse upstream metrics render as an em dash, and reconciliation matches on wallet + address + hash. The full never-fake rulebook behind the treasury dashboard.',
    readingTime: 4,
    tags: ['data-integrity', 'sync', 'engineering'],
    content: doc([
      para('A treasury dashboard that guesses is worse than no dashboard. fudcourt’s sync and API layers follow one doctrine: never fabricate a value, never hide a failure.'),
      heading('Closed for business beats empty and smiling'),
      para('Upstream error → loud 502 with the real status attached. Known-decoy surface → 503 refusal. Bad input → local 400, unknown resource → upstream 404 passthrough. An empty 200 is forbidden: an empty table is indistinguishable from “the market has nothing”, which is exactly how silent corruption hides.'),
      heading('Exact or nothing'),
      para('Reconciliation must match on wallet + address + transaction hash. Amount-and-date-only matches are treated as fakes. Sparse upstream metrics render as an em dash — never a zero — and the wallet sync raises on failed RPC instead of writing a balance of 0.'),
      heading('No-op parameters are lies'),
      para('A query parameter that does not change the response body is never exposed. When only a slice can be served honestly, the label states the slice — "top 100 of 4,975", not a page number that does nothing.'),
    ]),
  },
]

const payload = await getPayload({ config })

// categories (upsert by slug)
const catIds: string[] = []
for (const c of [
  { title: 'Methodology', slug: 'methodology', description: 'How fudcourt verifies data before it ships.' },
  { title: 'Engineering', slug: 'engineering', description: 'Sync rules, APIs, and post-mortems.' },
]) {
  const existing = await payload.find({ collection: 'categories', where: { slug: { equals: c.slug } }, limit: 1 })
  const saved = existing.docs[0]
    ? await payload.update({ collection: 'categories', id: existing.docs[0].id, data: c })
    : await payload.create({ collection: 'categories', data: c })
  catIds.push(saved.id as unknown as string) // relationship: keep native numeric id, do NOT stringify
}

// hero image: sharp SVG -> PNG buffer (single shared placeholder)
const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#0b1220"/><stop offset="100%" stop-color="#1e3a5f"/>
  </linearGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <text x="70" y="330" font-family="monospace" font-size="64" fill="#38bdf8">fudcourt / verified data</text>
  <text x="70" y="410" font-family="monospace" font-size="30" fill="#64748b">never fake · loud failures · gated boards</text>
</svg>`
const png = await sharp(Buffer.from(svg)).png().toBuffer()

const heroFound = await payload.find({ collection: 'media', where: { filename: { equals: 'fudcourt-hero.png' } }, limit: 1 })
const hero = heroFound.docs[0] ?? (await payload.create({
  collection: 'media',
  data: { alt: 'fudcourt verified-data banner' },
  file: { data: png, mimetype: 'image/png', name: 'fudcourt-hero.png', size: png.length },
}))
const heroId = hero.id

// posts (upsert by slug)
const saved: string[] = []
for (const p of POSTS) {
  const data = {
    ...p,
    status: 'published' as const,
    _status: 'published' as const,
    publishedAt: new Date().toISOString(),
    categories: catIds,
    heroImage: heroId,
    tags: p.tags.map((t) => ({ tag: t })),
  }
  const found = await payload.find({ collection: 'posts', where: { slug: { equals: p.slug } }, limit: 1 })
  const out: { id: string | number } = found.docs[0]
    ? (await payload.update({ collection: 'posts', id: found.docs[0].id, data: data as any }))
    : (await payload.create({ collection: 'posts', data: data as any }))
  saved.push(`${out.id}:${p.slug}`)
}

const count = await payload.count({ collection: 'posts' })
console.log(JSON.stringify({ posts: saved, total: count.totalDocs ?? (count as any).total, hero: String(heroId) }))
