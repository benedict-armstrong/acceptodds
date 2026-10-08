import type { MetadataRoute } from 'next';
import { siteUrl } from '@/server/share';
import { sitemapPaths } from '@/server/seo';

// Read from the database per request, never at build time.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteUrl();
  const fixed = ['/', '/about', '/leaderboard', '/map', '/docs', '/privacy'].map((path) => ({
    url: `${origin}${path === '/' ? '' : path}`,
    changeFrequency: 'daily' as const,
  }));
  const paths = await sitemapPaths();
  return [...fixed, ...paths.map((path) => ({ url: `${origin}${path}` }))];
}
