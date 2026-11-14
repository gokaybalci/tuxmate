import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  // GitHub Pages serves the fork from /<repo>; empty everywhere else
  basePath: process.env.PAGES_BASE_PATH || '',
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
