/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ustal/database", "@ustal/domain"],
};

export default nextConfig;
