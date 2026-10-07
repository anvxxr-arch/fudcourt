/**
 * publish-digest.ts — render the weekly treasury digest into the blog (Payload).
 *
 * WHY A SCRIPT, NOT A WEB ROUTE. This is a WRITE to the CMS, run on a schedule
 * by `fudcourt-digest.timer`. It is deliberately not a route: no HTTP surface
 * should be able to publish to the blog, and the CMS write needs the local API
 * (the REST API needs an authenticated user this host does not have).
 *
 * HOW TO RUN IT. `bun --bun run src/cms/publish-digest.ts` from `apps/web`,
 * with the env loaded (the systemd unit uses `EnvironmentFile=`).
 *   DO NOT use `bunx payload run` here: payload's `run` executes the script
 *   through tsx as CommonJS on this host (the package carries no `"type":
 *   "module"`), so the top-level await this script relies on is REJECTED with
 *   "Top-level await is currently not supported with the cjs output format".
 *   Bun runs the same file as native ESM, top-level await included, and reads
 *   the `@/` alias from tsconfig.json.
 *
 * THE REFUSAL IS LOUD. When the model refuses (a window with fewer than two
 * observations, a book with no priced holding), this prints the reason to
 * stderr and exits 1 — the timer shows a failed unit rather than silently
 * publishing nothing. A digest that cannot be stood behind is never written.
 *
 * The write is IDEMPOTENT: the post is keyed on its slug (the week it covers),
 * so re-running a week refreshes that post instead of creating a second one.
 *
 * PITFALLS carried from seed.ts: relationship ids stay NUMERIC (stringifying
 * fails validation); the upload/relationship field names are what Payload 3
 * expects; and a floating `main()` would be killed by the runtime, so the work
 * is TOP-LEVEL AWAIT.
 */
import { getPayload } from 'payload';
import { Client } from 'pg';
import config from '@/cms/payload.config';
import {
  buildDigest,
  digestExcerpt,
  digestOutline,
  digestSlug,
  digestTitle,
  readWeeklySnapshots,
  type DigestPublished,
} from '@/lib/digest';

/** The window the digest narrates. */
const WINDOW_DAYS = 7;

/** A weekly digest is its own category, so the blog can filter it. */
const CATEGORY = { title: 'Treasury', slug: 'treasury', description: 'The weekly treasury digest — derived from the committed series.' };

type LexNode = Record<string, unknown>;
const text = (t: string): LexNode => ({ type: 'text', text: t, format: 0, version: 1 });
const para = (t: string): LexNode => ({
  type: 'paragraph',
  children: [text(t)],
  direction: 'ltr',
  format: '',
  indent: 0,
  version: 1,
});
const heading = (t: string, level = 2): LexNode => ({
  type: 'heading',
  children: [text(t)],
  direction: 'ltr',
  format: '',
  indent: 0,
  version: 1,
  tag: `h${level}`,
});
// Payload's generated types are stricter than the runtime accepts; the tree is
// built by hand exactly as seed.ts does.
const doc = (blocks: LexNode[]): any => ({
  root: { type: 'root', children: blocks, direction: 'ltr', format: '', indent: 0, version: 1 },
});

/** The digest as a Lexical tree — headings + paragraphs, in outline order. */
function digestContent(digest: DigestPublished): LexNode[] {
  const blocks: LexNode[] = [];
  for (const section of digestOutline(digest)) {
    blocks.push(heading(section.heading));
    for (const line of section.body) blocks.push(para(line));
  }
  return blocks;
}

/** Reading time from the rendered word count (~200 wpm, min 1). */
function readingMinutes(digest: DigestPublished): number {
  const words = digestOutline(digest)
    .flatMap((s) => [s.heading, ...s.body])
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// ---- read the treasury series (local Postgres, DR-040) ----------------------
const pgUrl = process.env.FUDCOURT_PG_URL || 'postgres://fudcourt@127.0.0.1:5432/fudcourt';
const client = new Client({ connectionString: pgUrl });
await client.connect();
const snapshots = await readWeeklySnapshots(
  async (sql, args) => (await client.query(sql, args as never[])).rows as Record<string, unknown>[],
  WINDOW_DAYS,
);
await client.end();

const digest = buildDigest(snapshots);

if (digest.published === false) {
  const { reason, skipped } = digest;
  console.error(JSON.stringify({ refused: true, reason, skipped }));
  process.exit(1);
}

// ---- write it to the CMS ----------------------------------------------------
const payload = await getPayload({ config });

const slug = digestSlug(digest);

// category (upsert by slug, idempotent)
const catFound = await payload.find({ collection: 'categories', where: { slug: { equals: CATEGORY.slug } }, limit: 1 });
const category = catFound.docs[0]
  ? await payload.update({ collection: 'categories', id: catFound.docs[0].id, data: CATEGORY })
  : await payload.create({ collection: 'categories', data: CATEGORY });

const data = {
  title: digestTitle(digest),
  slug,
  excerpt: digestExcerpt(digest),
  content: doc(digestContent(digest)),
  status: 'published' as const,
  _status: 'published' as const,
  publishedAt: new Date().toISOString(),
  categories: [category.id as unknown as string], // relationship: keep native numeric id
  tags: [{ tag: 'treasury' }, { tag: 'weekly-digest' }, { tag: 'proof' }],
  readingTime: readingMinutes(digest),
};

const found = await payload.find({ collection: 'posts', where: { slug: { equals: slug } }, limit: 1 });
const saved = found.docs[0]
  ? await payload.update({ collection: 'posts', id: found.docs[0].id, data: data as any })
  : await payload.create({ collection: 'posts', data: data as any });

const count = await payload.count({ collection: 'posts' });
console.log(
  JSON.stringify({
    published: true,
    id: saved.id,
    slug,
    runs: digest.runs,
    startUsd: digest.startUsd,
    endUsd: digest.endUsd,
    changeUsd: digest.changeUsd,
    coverage: digest.coverage,
    totalPosts: count.totalDocs ?? (count as any).total,
  }),
);

// The work is done and the post is written. Exit EXPLICITLY: Payload holds the
// DB pool (and sharp's native handles) open, so the process would otherwise
// hang and a `Type=oneshot` unit would sit in `activating` until its timeout
// killed it — reading as a failed week. seed.ts gets this for free because
// payload's own CLI calls process.exit(0); a standalone script must do it.
process.exit(0);
