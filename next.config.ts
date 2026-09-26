import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Not optional: the production image copies .next/standalone and is ~200 MB
  // instead of ~1 GB. The deployment host's disk budget depends on it.
  output: 'standalone',
};

export default nextConfig;
