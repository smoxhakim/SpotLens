/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // TODO: enable typedRoutes once route surface stabilizes
  },
  images: {
    domains: [], // TODO: add asset logo / CDN domains
  },
};

module.exports = nextConfig;
