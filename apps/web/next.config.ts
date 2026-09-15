import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.REALTIME_INTERNAL_URL ?? 'http://127.0.0.1:4000'}/api/:path*`,
      },
    ];
  },
};
export default nextConfig;
