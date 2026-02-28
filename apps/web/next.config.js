/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@devroom/shared"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
