import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

/** The only implemented feed; named so the response can label its source. */
const RSS_FEED = 'https://cointelegraph.com/rss';
const SOURCES = ['cointelegraph'] as const;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const TIMEOUT_MS = 20_000;

type NewsItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  image: string;
  source: string;
};

function fail(message: string, status: number, detail?: string) {
  return NextResponse.json(
    { error: message, ...(detail ? { detail } : {}) },
    { status }
  );
}

const stripCdata = (s: string) => s.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
const grab = (item: string, re: RegExp) => item.match(re)?.[1] ?? '';

/**
 * Read-only cointelegraph RSS reader. Re-aligned 2026-09-28: `source` and
 * `limit` used to be silently coerced (unknown source -> empty 200, limit
 * clamped via Math.min, non-numeric -> NaN slice -> empty page) -- silent
 * lies about what the request did. Now they are OUR params with strict 400s,
 * the success envelope labels the feed it read, and an empty feed is a loud
 * 502 instead of an honest-looking empty list.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);

  const source = url.searchParams.get('source') ?? 'cointelegraph';
  if (!(SOURCES as readonly string[]).includes(source)) {
    return fail(`unknown source '${source}'`, 400, `expected one of ${SOURCES.join(', ')}`);
  }

  const limitRaw = url.searchParams.get('limit') ?? '30';
  if (!/^\d+$/.test(limitRaw)) {
    return fail(`limit must be an integer, got '${limitRaw}'`, 400, 'limit');
  }
  const limit = Number(limitRaw);
  if (limit < LIMIT_MIN || limit > LIMIT_MAX) {
    return fail(`limit must be between ${LIMIT_MIN} and ${LIMIT_MAX}, got ${limit}`, 400, 'limit');
  }

  try {
    const res = await fetch(RSS_FEED, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      // Loud: the real RSS status passes through, never a fake empty feed.
      return fail(`upstream ${res.status} from the RSS feed`, res.status);
    }
    const xml = await res.text();

    const items: NewsItem[] = [];
    const regex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const item = match[1];
      // <link> may or may not be CDATA-wrapped depending on the feed build.
      const rawLink = grab(item, /<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>/)
        || grab(item, /<link>([\s\S]*?)<\/link>/);
      items.push({
        title: stripCdata(grab(item, /<title>([\s\S]*?)<\/title>/)),
        link: rawLink.trim(),
        description: stripCdata(grab(item, /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/))
          .replace(/<[^>]*>/g, '').slice(0, 200),
        pubDate: stripCdata(grab(item, /<pubDate>([\s\S]*?)<\/pubDate>/)),
        image: grab(item, /<media:content url="([^"]+)"/),
        source: 'Cointelegraph',
      });
    }

    if (items.length === 0) {
      // An empty feed is breakage, not "no news exists".
      return fail('upstream returned an empty feed', 502, RSS_FEED);
    }

    return NextResponse.json({
      items: items.slice(0, limit),
      total: items.length,
      upstream: RSS_FEED,
      timestamp: Date.now(),
    });
  } catch (e) {
    return fail('upstream request failed', 502, e instanceof Error ? e.message : String(e));
  }
}
