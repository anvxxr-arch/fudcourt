import config from '@payload-config';
import { getPayload } from 'payload';
import Link from 'next/link';
import type { Metadata } from 'next';
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
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '48px 24px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>FudCourt Blog</h1>
      <p style={{ color: '#888', marginBottom: 40 }}>Insights, research, and playbooks.</p>
      {posts.length === 0 && <p style={{ color: '#666' }}>No posts yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {posts.map((post: any) => (
          <li key={post.id} style={{ marginBottom: 28, borderBottom: '1px solid #222', paddingBottom: 24 }}>
            <Link href={`/blog/${post.slug}`} style={{ fontSize: 20, color: '#4ade80', textDecoration: 'none' }}>
              {post.title}
            </Link>
            {post.excerpt && <p style={{ color: '#999', marginTop: 8 }}>{post.excerpt}</p>}
            {post.publishedAt && (
              <time style={{ color: '#666', fontSize: 13 }}>
                {new Date(post.publishedAt).toLocaleDateString()}
              </time>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}