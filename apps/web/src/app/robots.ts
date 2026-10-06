import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: ['/api/', '/admin', '/team', '/member', '/blog/cms/'],
    },
    sitemap: 'https://fc.dwirijal.my.id/sitemap.xml',
  };
}
