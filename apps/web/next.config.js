const { withPayload } = require('@payloadcms/next/withPayload');

// One Next app serves the treasury OS and the Payload CMS blog (DR-017). The
// blog's own config (output: standalone, typescript.ignoreBuildErrors) is
// deliberately NOT inherited: `ignoreBuildErrors` existed because the blog was
// built in isolation and its Payload-generated types lagged the schema — in the
// merged app the same flag would hide real type errors across the whole
// dashboard, which is the exact regression the typecheck gate exists to catch.
// The typecheck must therefore pass under React 19 before this is deployed.
const nextConfig = {
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
      // 404. /market/crypto is the board; /market/ticker is the detail namespace.
      { source: '/ticker', destination: '/market/crypto', permanent: false },
      { source: '/ticker/:ticker', destination: '/market/ticker/:ticker', permanent: false },
      { source: '/markets', destination: '/market', permanent: false },
      { source: '/market/ticker', destination: '/market/crypto', permanent: false },
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
module.exports = withPayload(nextConfig, { devBundleServerPackages: false });
