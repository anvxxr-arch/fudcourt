const nextConfig = {
  // /portfolio entry kept after dropping the Vercel deploy (DR-002): same two
  // rules apps/web/vercel.json used to carry, now served by Next itself so the
  // path works identically on the self-hosted production host.
  async rewrites() {
    return [
      { source: '/portfolio', destination: '/' },
      { source: '/portfolio/:path*', destination: '/:path*' },
    ];
  },
};
module.exports = nextConfig;
