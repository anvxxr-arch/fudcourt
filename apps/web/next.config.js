const { withPayload } = require('@payloadcms/next/withPayload');

// One Next app serves the treasury OS and the Payload CMS blog (DR-017). The
// blog's own config (output: standalone, typescript.ignoreBuildErrors) is
// deliberately NOT inherited: `ignoreBuildErrors` existed because the blog was
// built in isolation and its Payload-generated types lagged the schema — in the
// merged app the same flag would hide real type errors across the whole
// dashboard, which is the exact regression the typecheck gate exists to catch.
// The typecheck must therefore pass under React 19 before this is deployed.
const nextConfig = {
  // The macro dashboard reads dozens of upstream series at BUILD time: its loader
  // runs inside static generation so the figures land in the first paint instead of
  // growing the cards on the client (see features/economy/server-boards.ts).
  // Measured on this host 2026-10-10, against the running service: the five boards
  // cost 31.4s sequentially, and the slowest one alone (calendar) 24.4s warm. A
  // cold run under load metered past Next's 60s default on all three attempts,
  // which fails static generation and took the entire build — and therefore the
  // served app — down. 300s is ~10x the warm worst board and 5x the threshold that
  // failed, so a cold build still lands. The key is TOP-LEVEL, not under
  // `experimental`: this Next reads `result.staticPageGenerationTimeout` directly
  // (dist/server/config.js), so nesting it would be silently ignored.
  staticPageGenerationTimeout: 300,
  // Portfolio moved to /team/portfolio: the legacy /portfolio entry now
  // redirects there (was: rewrite /portfolio -> /). The /:path* fallthrough
  // keeps any deeper legacy /portfolio/* link landing on the matching top
  // route instead of 404ing. Trailing-slash behavior is untouched (Next
  // default: no forced trailing slash), so /portfolio and /portfolio/ both
  // redirect identically.
  async redirects() {
    return [
      { source: '/portfolio', destination: '/team/portfolio', permanent: false },
      // The ticker area moved under the market hub (asset-class sections). The
      // old standalone paths redirect so external links and the sitemap never
      // 404. /market/crypto is the board and its coin detail pages live at
      // /market/crypto/[ticker]; the former /market/ticker namespace is gone.
      { source: '/ticker', destination: '/market/crypto', permanent: false },
      { source: '/ticker/:ticker', destination: '/market/crypto/:ticker', permanent: false },
      { source: '/markets', destination: '/market', permanent: false },
      { source: '/market/ticker', destination: '/market/crypto', permanent: false },
      // The old detail namespace's own deep links: /market/ticker/BTC now lives
      // at /market/crypto/BTC. Kept as a redirect rather than a 404 because
      // those URLs were in the sitemap and are linked from the trade board.
      { source: '/market/ticker/:ticker', destination: '/market/crypto/:ticker', permanent: false },
      // The standalone boards folded into the market hub as tabs: /tracker and
      // /llama are the crypto section's Prices and DeFi TVL tabs, /dex and
      // /trench are the trench section's Pairs and Trench tabs. Their page
      // routes are gone, so old links redirect into the hub (the tab itself is
      // client state, so the redirect lands on the section, not a tab).
      { source: '/tracker', destination: '/market/crypto', permanent: false },
      { source: '/llama', destination: '/market/crypto', permanent: false },
      { source: '/dex', destination: '/market/trench', permanent: false },
      { source: '/trench', destination: '/market/trench', permanent: false },
    ];
  },
  async rewrites() {
    return [{ source: '/portfolio/:path*', destination: '/:path*' }];
  },
  // Round-5 hardening: security headers on every response. Round-6 adds the
  // staged CSP from /tmp/audit_security_r5.md §1 as REPORT-ONLY — it never
  // blocks loads; violations only surface in the browser console. No
  // report-uri/report-to is shipped because the app has no trivial report
  // endpoint (only /api/img); add one before ever promoting to enforced
  // `Content-Security-Policy`. Enforcement would also need nonces/hashes for
  // the inline hydration scripts ('unsafe-inline' stays until then).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy-Report-Only',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://fc.dwirijal.my.id wss: https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
          },
        ],
      },
      // The crawler files were serving `public, max-age=0, must-revalidate`
      // despite the sitemap declaring `revalidate = 3600`: Next's default for a
      // static route with no explicit header. That forced every search-engine
      // re-crawl back to the origin for a document that changes hourly at most
      // (the sitemap's own `revalidate`) and never for robots. The windows here
      // mirror those exports rather than inventing a new cadence: 3600s for the
      // sitemap, 14400s for robots (which changes only when the crawl policy
      // does). `stale-while-revalidate` keeps a stale copy answering a crawler
      // while the refresh runs, so a re-crawl never pays the origin's latency.
      {
        source: '/sitemap.xml',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400' },
        ],
      },
      {
        source: '/robots.txt',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=14400, s-maxage=14400, stale-while-revalidate=86400' },
        ],
      },
    ];
  },
  // Pin the workspace root explicitly: the monorepo has two lockfiles, and
  // without this Next infers the wrong one and warns on every build.
  turbopack: {
    root: __dirname,
  },
  // The Next dev issue badge floats bottom-left and overlaps the public
  // boards' table headers in QA screenshots; move it out of the way.
  devIndicators: { position: 'bottom-right' },
};

// withPayload injects the Payload webpack/turbopack aliases and the admin route
// handling; `devBundleServerPackages: false` is the blog's proven setting.
const payloadConfig = withPayload(nextConfig, { devBundleServerPackages: false });

// ---------------------------------------------------------------------------
// Critical-CH removal on the public frontend (DR-018).
//
// `withPayload` appends a `/:path*` header group carrying
// `Accept-CH: Sec-CH-Prefers-Color-Scheme` and `Critical-CH: <same>`. Chrome
// treats a `Critical-CH` hint it has not yet sent as a reason to RETRY the
// whole navigation: the first document request is answered with a 307 whose
// `Vary` includes the hint, the browser re-issues it with
// `Sec-CH-Prefers-Color-Scheme` attached, and only the second response carries
// the page. Lighthouse's `redirects` audit scores that 0 (measured: est.
// savings 610-660 ms on `/` and `/economy`; the 307's URL is identical to the
// request, which is the retry signature, not a routing bug). The header is
// only useful to Payload's admin UI, which reads it in `getRequestTheme` to
// pick the admin colour scheme before paint — so the hint is kept on `/blog`
// (the admin's whole route tree) and withdrawn everywhere else.
//
// This is done here, in the config, because it CANNOT be done in
// `src/middleware.ts`: `resolve-routes.js` applies the config header group
// before middleware runs and merges the middleware's own headers with
// `resHeaders[key] = value`, so a middleware can add or overwrite a header but
// can never delete one. (The `x-middleware-override-headers` mechanism rewrites
// the REQUEST only — verified by reading the router source, not assumed.)
//
// `poweredByHeader: false` is what keeps the two groups from colliding: the
// `X-Powered-By` value follows whichever group sets it last, so without it the
// second group would emit the bare `Next.js` default and silently drop
// Payload's `Next.js, Payload`. With it, the wrapper stops injecting the group
// entirely and we carry Payload's exact value plus its own guard.
/** Payload's X-Powered-By value, re-emitted so `poweredByHeader: false` costs nothing. */
const POWERED_BY = { key: 'X-Powered-By', value: 'Next.js, Payload' };

/**
 * Re-scope Payload's single `/:path*` hint group to the admin only:
 *  - `/:path((?!blog(?:/|$)).*)` is the whole site MINUS `/blog/**`. It carries
 *    only `X-Powered-By`, so the hint is absent — which is the fix — while the
 *    route still matches and falls through to the page render;
 *  - the original group, kept whole, is scoped to `/blog/:path*`.
 *
 * Both groups fall through to the render (neither sets a destination), so each
 * must re-emit `X-Powered-By`; `poweredByHeader: false` means nothing else will.
 */
function scopeClientHintToBlog(config) {
  const original = config.headers;
  const headers = async () => {
    const groups = typeof original === 'function' ? await original() : (original ?? []);
    const split = [];
    for (const group of groups) {
      const hasHint = group.headers?.some((h) => h.key === 'Accept-CH');
      if (!hasHint) {
        // Every other group (the app's own security headers) is kept verbatim.
        split.push(group);
        continue;
      }
      // `:path*` cannot express "not /blog", and the `(?!…)` group is the only
      // way to carve the admin out; the blog scope then re-enables it. Both
      // groups fall through to the page render, so each must also carry
      // `X-Powered-By` — `poweredByHeader: false` means nothing else will.
      split.push({ source: '/:path((?!blog(?:/|$)).*)', headers: [POWERED_BY] });
      split.push({ source: '/blog/:path*', headers: group.headers });
    }
    return split;
  };
  return {
    ...config,
    // Owned here: Payload's guard replaces the `X-Powered-By` header with the
    // bare Next.js default, which would drop the `Payload` token off every route.
    poweredByHeader: false,
    headers,
  };
}

module.exports = scopeClientHintToBlog(payloadConfig);
