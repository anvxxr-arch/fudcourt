import config from '@payload-config';
import { getPayload } from 'payload';
import Link from 'next/link';
import type { Metadata } from 'next';
import { color, fontFamily, fontSize, space } from '@/styles/tokens';
export const metadata: Metadata = {
  title: 'FudCourt Blog',
  description: 'Insights, research, and playbooks from FudCourt.',
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
      <h1 style={{ fontSize: fontSize[28], marginBottom: space[8] }}>FudCourt Blog</h1>
      <p style={{ color: color.labelTertiary, marginBottom: space[40] }}>Insights, research, and playbooks.</p>
      {posts.length === 0 && <p style={{ color: color.labelTertiary }}>No posts yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {posts.map((post: any) => (
          <li key={post.id} style={{ marginBottom: space[32], borderBottom: `1px solid ${color.separator}`, paddingBottom: space[24] }}>
            <Link href={`/blog/${post.slug}`} style={{ fontSize: fontSize[20], color: color.green, textDecoration: 'none' }}>
              {post.title}
            </Link>
            {post.excerpt && <p style={{ color: color.labelTertiary, marginTop: space[8] }}>{post.excerpt}</p>}
            {post.publishedAt && (
              <time style={{ color: color.labelTertiary, fontSize: fontSize[13] }}>
                {new Date(post.publishedAt).toLocaleDateString()}
              </time>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}