import config from '@payload-config';
import { getPayload } from 'payload';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';

const POST_SEO: Record<string, { title: string; description: string }> = {
  'never-fake-rules': {
    title: 'Never Fake: Sync Integrity Rules for a Trustworthy Treasury',
    description: 'Failed RPC calls never become zero and sparse metrics render as dashes, never guesses. The never-fake rulebook behind the FudCourt treasury dashboard.',
  },
  'the-decoy-that-passed-parity': {
    title: 'Decoy That Passed Parity: How We Rejected a Fabricated Feed',
    description: 'A payload can agree with itself and a second source and still be fabricated. How FudCourt funding routes served a decoy — and how the class got rejected.',
  },
  'how-a-board-is-gated': {
    title: 'How a Market Board Is Gated: Three Checks Before Data Ships',
    description: 'Parity with a second source, decoy-class screening, freshness bounds: the three checks every FudCourt market board must pass before any figure ships.',
  },
};

const POST_CTA: Record<string, { heading: string; body: string; nextHref: string; nextLabel: string }> = {
  'never-fake-rules': { heading: 'Never-fake, running live.', body: 'These sync rules gate every figure on the market boards.', nextHref: '/blog/the-decoy-that-passed-parity', nextLabel: 'Next: the decoy that passed parity →' },
  'the-decoy-that-passed-parity': { heading: 'Decoys get rejected, not averaged in.', body: 'The screening in this post-mortem runs on every board publish.', nextHref: '/blog/how-a-board-is-gated', nextLabel: 'Next: how a board gets gated →' },
  'how-a-board-is-gated': { heading: 'Three checks. Every board. Every publish.', body: 'Parity, decoy screening, freshness — see the output on the live boards, or screen your own watchlist.', nextHref: '/signals', nextLabel: 'See signal screening →' },
};

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const seo = POST_SEO[slug];
  if (!seo) return { title: 'FudCourt Blog', description: 'Market-integrity research, post-mortems and playbooks from the FudCourt team.' };
  const path = `/blog/${slug}`;
  return {
    title: seo.title,
    description: seo.description,
    authors: [{ name: 'FudCourt Team' }],
    alternates: { canonical: path },
    openGraph: { title: seo.title, description: seo.description, url: path, siteName: 'FUDCOURT', type: 'article', images: ['/og-cover.png'] },
    twitter: { card: 'summary_large_image', title: seo.title, description: seo.description, images: ['/og-cover.png'] },
  };
}
import { color, fontFamily, fontSize, lineHeight, space , fontWeight } from '@/styles/tokens';

export const dynamic = 'force-dynamic';

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const payload = await getPayload({ config });
  const { docs } = await payload.find({
    collection: 'posts',
    where: { slug: { equals: slug }, status: { equals: 'published' } },
    limit: 1,
    depth: 2,
  });

  const post: any = docs[0];
  if (!post) notFound();

  const seo = POST_SEO[slug];
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.excerpt ?? seo?.description ?? '',
    datePublished: post.publishedAt ? new Date(post.publishedAt).toISOString() : undefined,
    author: { '@type': 'Organization', name: 'FudCourt', url: 'https://fc.dwirijal.my.id' },
    publisher: { '@type': 'Organization', name: 'FudCourt' },
    mainEntityOfPage: `https://fc.dwirijal.my.id/blog/${slug}`,
  };

  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: `48px ${space[24]}px`,
        fontFamily: fontFamily.sans,
        lineHeight: lineHeight.loose,
      }}
    >
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <a href="/blog" style={{ color: color.green, textDecoration: 'none', fontSize: fontSize[15] }}>
        ← All posts
      </a>
      <h1 style={{ fontSize: fontSize[28], margin: `${space[24]}px 0 ${space[8]}px` }}>{post.title}</h1>
      <p style={{ color: color.labelTertiary, fontSize: fontSize[13], margin: `${space[8]}px 0 0` }}>
        By <span style={{ fontWeight: fontWeight.semibold, color: color.labelPrimary }}>FudCourt Team</span>
        {post.publishedAt && (
          <>
            {' '}·{' '}
            <time dateTime={new Date(post.publishedAt).toISOString()}>
              {new Date(post.publishedAt).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
          </>
        )}
      </p>
      {post.excerpt && (
        <p style={{ color: color.labelTertiary, fontStyle: 'italic', marginTop: space[20] }}>{post.excerpt}</p>
      )}
      <hr style={{ border: 0, borderTop: `1px solid ${color.separator}`, margin: `${space[32]}px 0` }} />
      <article>{post.content ? <RichText data={post.content} /> : <p>No content.</p>}</article>
      {POST_CTA[slug] && (
        <section style={{ marginTop: space[40], borderTop: `1px solid ${color.separator}`, paddingTop: space[24] }}>
          <h2 style={{ fontSize: fontSize[20], marginBottom: space[8] }}>{POST_CTA[slug].heading}</h2>
          <p style={{ color: color.labelTertiary, marginBottom: space[16] }}>{POST_CTA[slug].body}</p>
          <div style={{ display: 'flex', gap: space[16], flexWrap: 'wrap' }}>
            <a href="/market" style={{ color: color.green, fontWeight: fontWeight.bold, textDecoration: 'none' }}>
              See a gated board &rarr;
            </a>
            <a href={POST_CTA[slug].nextHref} style={{ color: color.green, textDecoration: 'none' }}>
              {POST_CTA[slug].nextLabel}
            </a>
          </div>
        </section>
      )}
    </main>
  );
}

function RichText({ data }: { data: any }) {
  const nodes = data?.root?.children ?? [];
  return (
    <>
      {nodes.map((node: any, i: number) => (
        <Block key={node.key ?? i} node={node} />
      ))}
    </>
  );
}

function Block({ node }: { node: any }): any {
  const text = (children: any[]) =>
    (children ?? [])
      .map((c: any) =>
        c.type === 'text' ? c.text : (c.children ?? []).map((x: any) => x.text).join('')
      )
      .join('');

  switch (node.type) {
    case 'heading': {
      const Tag: any = `h${node.tag ?? '2'}`;
      return <Tag>{text(node.children)}</Tag>;
    }
    case 'list':
      return node.listType === 'number' ? (
        <ol>
          {node.children?.map((li: any, i: number) => (
            <li key={i}>{text(li.children)}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {node.children?.map((li: any, i: number) => (
            <li key={i}>{text(li.children)}</li>
          ))}
        </ul>
      );
    case 'quote':
      return <blockquote>{text(node.children)}</blockquote>;
    case 'paragraph':
      return <p>{text(node.children)}</p>;
    default:
      return (
        <>
          {(node.children ?? []).map((child: any, i: number) => (
            <Block key={child.key ?? i} node={child} />
          ))}
        </>
      );
  }
}
