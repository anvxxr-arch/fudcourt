import config from '@payload-config';
import { getPayload } from 'payload';
import Link from 'next/link';
import type { Metadata } from 'next';
import { themeColor, fontFamily, fontSize, space, fontWeight } from '@/styles/tokens';
export const metadata: Metadata = {
  title: 'FudCourt Blog — Market Integrity Research & Trade Playbooks',
  description:
    'FudCourt Blog: market-integrity research, post-mortems and playbooks — never-fake sync rules, decoy detection, and the checks that gate every market board.',
  alternates: { canonical: '/blog' },
  openGraph: {
    title: 'FudCourt Blog — Market Integrity Research & Trade Playbooks',
    description: 'Market-integrity research, post-mortems and playbooks from the FudCourt team.',
    url: '/blog',
    siteName: 'FUDCOURT',
    type: 'website',
    images: ['/og-cover.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FudCourt Blog — Market Integrity Research & Trade Playbooks',
    description: 'Market-integrity research, post-mortems and playbooks from the FudCourt team.',
    images: ['/og-cover.png'],
  },
};

export const dynamic = 'force-dynamic';

export default async function BlogIndex() {
  const payload = await getPayload({ config });
  const { docs: posts } = await payload.find({
    collection: 'posts',
    where: { status: { equals: 'published' } },
    sort: '-publishedAt',
    limit: 50,
    depth: 1,
  });

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: `48px ${space[24]}px`, fontFamily: fontFamily.sans }}>
      <h1 style={{ fontSize: fontSize[28], marginBottom: space[8] }}>FudCourt Blog: market-integrity research</h1>
      <p style={{ color: themeColor.labelSecondary, marginBottom: space[40] }}>Post-mortems and playbooks for traders and treasury teams — never-fake sync rules, decoy detection, and the checks that gate every market board.</p>
      {posts.length === 0 && <p style={{ color: themeColor.labelSecondary }}>No posts yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {posts.map((post: any) => (
          <li key={post.id} style={{ marginBottom: space[32], borderBottom: `1px solid ${themeColor.separator}`, paddingBottom: space[24] }}>
            <Link href={`/blog/${post.slug}`} style={{ fontSize: fontSize[20], color: themeColor.blue, textDecoration: 'none' }}>
              {post.title}
            </Link>
            {post.excerpt && <p style={{ color: themeColor.labelSecondary, marginTop: space[8] }}>{post.excerpt}</p>}
            {post.publishedAt && (
              <time style={{ color: themeColor.labelSecondary, fontSize: fontSize[13] }}>
                {new Date(post.publishedAt).toLocaleDateString()}
              </time>
            )}
          </li>
        ))}
      </ul>
      <section style={{ marginTop: space[40], borderTop: `1px solid ${themeColor.separator}`, paddingTop: space[24] }}>
        <h2 style={{ fontSize: fontSize[20], marginBottom: space[8] }}>Like how we think? See it running.</h2>
        <p style={{ color: themeColor.labelSecondary, marginBottom: space[16] }}>
          Every rule in these posts ships in the live product. Open the market hub to see gated boards, or read how a board gets gated first.
        </p>
        <div style={{ display: 'flex', gap: space[16], flexWrap: 'wrap' }}>
          <Link href="/market" style={{ color: themeColor.blue, fontWeight: fontWeight.bold, textDecoration: 'none' }}>
            Open the market hub &rarr;
          </Link>
          <Link href="/blog/how-a-board-is-gated" style={{ color: themeColor.blue, textDecoration: 'none' }}>
            How gating works &rarr;
          </Link>
        </div>
      </section>
    </main>
  );
}