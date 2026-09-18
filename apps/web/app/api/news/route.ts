import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const source = url.searchParams.get('source') || 'cointelegraph';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 100);

    let items = [];

    if (source === 'cointelegraph') {
      const res = await fetch('https://cointelegraph.com/rss');
      if (!res.ok) throw new Error(`RSS ${res.status}`);
      const xml = await res.text();
      
      const regex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        const item = match[1];
        const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
        const link = item.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/)?.[1] || '';
        const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || '';
        const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
        const media = item.match(/<media:content url="([^"]+)"/)?.[1] || '';
        
        items.push({
          title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
          link,
          description: desc.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, '').slice(0, 200),
          pubDate,
          image: media,
          source: 'Cointelegraph',
        });
      }
    }

    return NextResponse.json({ items: items.slice(0, limit), timestamp: Date.now() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message, items: [] }, { status: 500 });
  }
}
