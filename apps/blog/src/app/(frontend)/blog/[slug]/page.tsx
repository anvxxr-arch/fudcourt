import config from '@payload-config';
import { getPayload } from 'payload';
import { notFound } from 'next/navigation';

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

  return (
    <main
      style={{
        maxWidth: 720,
        margin: '0 auto',
        padding: '48px 24px',
        fontFamily: 'system-ui, sans-serif',
        lineHeight: 1.7,
      }}
    >
      <a href="/" style={{ color: '#4ade80', textDecoration: 'none', fontSize: 14 }}>
        ← All posts
      </a>
      <h1 style={{ fontSize: 34, margin: '24px 0 8px' }}>{post.title}</h1>
      {post.publishedAt && (
        <time style={{ color: '#666', fontSize: 13 }}>
          {new Date(post.publishedAt).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </time>
      )}
      {post.excerpt && (
        <p style={{ color: '#999', fontStyle: 'italic', marginTop: 20 }}>{post.excerpt}</p>
      )}
      <hr style={{ border: 0, borderTop: '1px solid #222', margin: '32px 0' }} />
      <article>{post.content ? <RichText data={post.content} /> : <p>No content.</p>}</article>
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