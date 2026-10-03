import type { NextConfig } from 'next';
import { PRIVATE_PAGES } from './src/lib/private-paths';

const nextConfig: NextConfig = {
  async headers() {
    return PRIVATE_PAGES.map((source) => ({
      source,
      headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
    }));
  },
  // Not optional: the production image copies .next/standalone and is ~200 MB
  // instead of ~1 GB. The deployment host's disk budget depends on it.
  output: 'standalone',
  // The link-preview images read their font from disk (src/server/og.tsx);
  // standalone output only copies files it can trace, so name it.
  outputFileTracingIncludes: {
    '/papers/[slug]/opengraph-image': ['./assets/fonts/*.ttf'],
    '/markets/[slug]/opengraph-image': ['./assets/fonts/*.ttf'],
  },
};

export default nextConfig;
