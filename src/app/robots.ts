import type { MetadataRoute } from 'next';
import { PRIVATE_PAGES } from '@/lib/private-paths';
import { siteUrl } from '@/server/share';

/**
 * Public pages and the read API's documentation are open to everyone,
 * crawlers and AI agents alike. Closed: the private pages
 * (`lib/private-paths.ts`) and the API itself (`/docs` and `openapi.json`
 * describe it; crawling the endpoints would only spend a bot's rate limit).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: ['/', '/api/v1/openapi.json'], disallow: ['/api/', ...PRIVATE_PAGES] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
