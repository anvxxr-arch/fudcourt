/**
 * /api/img contract tests: run OFFLINE — no network, no clock waiting.
 *
 * The proxy's job (LH `image-aspect-ratio`) is not just to downscale, it is to
 * hand the browser a SQUARE intrinsic box for the square 16x16 render sites:
 * a 400x200 logo served at its native 2:1 ratio was being squished into the
 * 16x16 element (distortion). `fit: 'contain'` letterboxes the scaled image
 * inside a 64px transparent square, so `naturalWidth === naturalHeight` always.
 *
 * The upstream seam is `globalThis.fetch`, which the route calls directly, so a
 * stub that answers a real PNG (non-square in, square out) drives the whole
 * path including sharp. Asserting the OUTPUT metadata, not the source text, is
 * what makes this a behaviour test rather than a grep.
 *
 * Usage: cd apps/web && bun test --preload ./tests/preload.ts ./tests/img-proxy-tests.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { NextRequest } from 'next/server';
import { GET } from '@/app/(frontend)/api/img/route';

/** Serve one real PNG of the given size to every upstream fetch the route makes. */
async function stubUpstreamDims(width: number, height: number): Promise<() => void> {
  const png = await sharp({
    create: { width, height, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
  })
    .png()
    .toBuffer();
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array(png), {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.byteLength) },
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// Allowlisted host + HTTPS, so the route reaches the sharp stage.
const req = (host = 'icons.llamao.fi') =>
  new NextRequest(`https://app.test/api/img?u=${encodeURIComponent(`https://${host}/logo.png`)}`);

test('img: a wide source is padded to a square, not served at its native ratio', async () => {
  const restore = await stubUpstreamDims(400, 200);
  try {
    const res = await GET(req());
    assert.equal(res.status, 200);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(meta.width, 64, 'the box is 64px (2x the 16px render site at DPR 2)');
    assert.equal(
      meta.height,
      meta.width,
      `a 400x200 source must come back square, got ${meta.width}x${meta.height}`,
    );
  } finally {
    restore();
  }
});

test('img: a tall source is padded to the same square', async () => {
  const restore = await stubUpstreamDims(200, 480);
  try {
    const res = await GET(req());
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.equal(meta.width, 64);
    assert.equal(meta.height, 64, `a 200x480 source must come back square, got ${meta.width}x${meta.height}`);
  } finally {
    restore();
  }
});

test('img: an already-square source is unchanged in shape and stays downscaled', async () => {
  const restore = await stubUpstreamDims(512, 512);
  try {
    const res = await GET(req());
    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    assert.equal(meta.width, 64);
    assert.equal(meta.height, 64);
    assert.equal(meta.format, 'webp', 'still re-encoded to the compact webp output');
    assert.ok(buf.byteLength < 64 * 64 * 4, 'a 512px source must not ship at its source size');
  } finally {
    restore();
  }
});

test('img: the immutable 1y cache and content-type contract is unchanged', async () => {
  const restore = await stubUpstreamDims(300, 300);
  try {
    const res = await GET(req());
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.equal(res.headers.get('content-length'), String((await res.arrayBuffer()).byteLength));
  } finally {
    restore();
  }
});

test('img: a non-allowlisted host is still refused before any fetch', async () => {
  let fetched = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    return new Response('nope');
  }) as unknown as typeof fetch;
  try {
    const res = await GET(req('evil.example.com'));
    assert.equal(res.status, 403);
    assert.equal(fetched, false, 'the allowlist must reject before the upstream is touched');
  } finally {
    globalThis.fetch = original;
  }
});
