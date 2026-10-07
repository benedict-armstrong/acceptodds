import type { NextConfig } from 'next';
import { PRIVATE_PAGES } from './src/lib/private-paths';

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // A mail link wrapped at its hyphen and cut there (before mails had an HTML part, `lib/mail-html.ts`)
      // still confirmed the address, then landed here. The query, if any survived, carries over.
      { source: '/verify-', destination: '/verify-email', permanent: false },
      // A guessed address: there is no sign-up page of its own. `/signin` sends a first visit on to `/welcome`.
      { source: '/signup', destination: '/signin', permanent: false },
    ];
  },
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
